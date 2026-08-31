import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import type { Database } from "../src/drizzle"
import {
  PAYMENT_RECOVERY_BASE_RETRY_MS,
  PAYMENT_RECOVERY_MAX_ATTEMPTS,
  paymentRecoveryFingerprint,
  processPaymentRecoveries,
  recordPaymentDeadLetter,
  retryPaymentRecoveryWithDb,
  PaymentRecoveryRetryError,
} from "../src/payment-recovery"
import { createPaymentQueueEvent } from "../src/payment-queue"
import * as schema from "../src/schema-d1"

const now = 2_000_000_000_000

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

async function setup() {
  const sqlite = new SQLite(":memory:")
  sqlite.exec(await migrationSql())
  const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test adapter implements the D1 subset
  const db = drizzleDb as unknown as Database.TxOrDb
  const use = <T>(callback: (value: Database.TxOrDb) => Promise<T>) => callback(db)
  const transaction = async <T>(callback: (value: Database.TxOrDb) => Promise<T>) => {
    sqlite.exec("BEGIN IMMEDIATE")
    try {
      const result = await callback(db)
      sqlite.exec("COMMIT")
      return result
    } catch (error) {
      sqlite.exec("ROLLBACK")
      throw error
    }
  }
  return { sqlite, use, transaction }
}

function payment(suffix = "1") {
  return createPaymentQueueEvent(
    {
      provider: "qpay",
      merchantAccountID: "merchant_recovery",
      externalEventID: `event_recovery_${suffix}`,
      externalInvoiceID: `invoice_recovery_${suffix}`,
      externalPaymentID: `payment_recovery_${suffix}`,
      amount: 39_000,
      currency: "MNT",
      type: "paid",
      payloadHash: suffix.padStart(64, "a").slice(-64),
      occurredAt: now - 1_000,
    },
    now - 500,
  )
}

describe("payment dead-letter recovery", () => {
  test("stores valid events idempotently and quarantines invalid bodies without raw secrets", async () => {
    const { sqlite, transaction } = await setup()
    const event = payment()

    const first = await recordPaymentDeadLetter({ body: event, now }, { transaction })
    const replay = await recordPaymentDeadLetter({ body: event, now: now + 1 }, { transaction })
    expect(first).toMatchObject({ status: "pending", validEvent: true, changed: true })
    expect(replay).toEqual({ ...first, changed: false })
    const conflict = await recordPaymentDeadLetter(
      {
        body: createPaymentQueueEvent({ ...event.event, amount: 49_000 }, event.enqueuedAt + 1),
        now: now + 1,
      },
      { transaction },
    ).catch((error) => error)
    expect(conflict).toBeInstanceOf(Error)
    expect(conflict).toHaveProperty("message", expect.stringContaining("өмнөх event-тэй зөрчилдөж байна"))

    const invalidSecret = "must-never-be-stored"
    const invalid = await recordPaymentDeadLetter(
      { body: { version: 2, token: invalidSecret }, now: now + 2 },
      { transaction },
    )
    expect(invalid).toMatchObject({ status: "manual_review", validEvent: false, changed: true })

    const rows = sqlite
      .query<
        { message_hash: string; event: string | null; status: string; last_error_code: string | null },
        []
      >("select message_hash, event, status, last_error_code from payment_recovery order by time_created, id")
      .all()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ status: "pending", last_error_code: null })
    expect(rows[1]).toMatchObject({
      status: "manual_review",
      event: null,
      last_error_code: "invalid_payment_queue_event",
    })
    expect(JSON.stringify(rows)).not.toContain(invalidSecret)
    expect(rows.every((row) => typeof row.message_hash === "string" && row.message_hash.length === 64)).toBe(true)
    expect(sqlite.query("select count(*) as count from admin_audit_log").get()).toEqual({ count: 2 })
    const storedHash = rows[0]?.message_hash
    if (typeof storedHash !== "string") throw new Error("Төлбөрийн recovery hash хадгалагдсангүй")
    expect(await paymentRecoveryFingerprint(event)).toBe(storedHash)

    const archivedInvalidHash = "b".repeat(64)
    const archivedInvalid = await recordPaymentDeadLetter(
      { body: undefined, now: now + 3, trustedMessageHash: archivedInvalidHash },
      { transaction },
    )
    expect(archivedInvalid).toMatchObject({ status: "manual_review", validEvent: false, changed: true })
    expect(
      sqlite.query("select message_hash, event from payment_recovery where message_hash = ?").get(archivedInvalidHash),
    ).toEqual({ message_hash: archivedInvalidHash, event: null })
  })

  test("backs off a failed apply and resolves the idempotent retry", async () => {
    const { sqlite, use, transaction } = await setup()
    await recordPaymentDeadLetter({ body: payment(), now }, { transaction })
    let calls = 0
    const apply = async () => {
      calls++
      if (calls === 1) throw new Error("temporary D1 failure")
    }

    expect(await processPaymentRecoveries({ now }, { apply, use, transaction })).toEqual({
      resolved: 0,
      retried: 1,
      manualReview: 0,
      skipped: 0,
      truncated: false,
    })
    expect(
      sqlite.query("select status, attempts, last_error_code, time_next_attempt from payment_recovery").get(),
    ).toEqual({
      status: "pending",
      attempts: 1,
      last_error_code: "payment_apply_failed",
      time_next_attempt: now + PAYMENT_RECOVERY_BASE_RETRY_MS,
    })

    expect(
      await processPaymentRecoveries({ now: now + PAYMENT_RECOVERY_BASE_RETRY_MS - 1 }, { apply, use, transaction }),
    ).toMatchObject({ resolved: 0, retried: 0 })
    expect(calls).toBe(1)

    expect(
      await processPaymentRecoveries({ now: now + PAYMENT_RECOVERY_BASE_RETRY_MS }, { apply, use, transaction }),
    ).toMatchObject({ resolved: 1, retried: 0, manualReview: 0 })
    expect(calls).toBe(2)
    expect(sqlite.query("select status, attempts, last_error_code, time_resolved from payment_recovery").get()).toEqual(
      {
        status: "resolved",
        attempts: 2,
        last_error_code: null,
        time_resolved: now + PAYMENT_RECOVERY_BASE_RETRY_MS,
      },
    )
    expect(sqlite.query("select action, outcome from admin_audit_log order by time_created, id").all()).toEqual([
      { action: "payment_recovery.dead_lettered", outcome: "failure" },
      { action: "payment_recovery.resolved", outcome: "success" },
    ])
  })

  test("reclaims expired leases and sends the final failed attempt to manual review", async () => {
    const { sqlite, use, transaction } = await setup()
    const leased = await recordPaymentDeadLetter({ body: payment("2"), now }, { transaction })
    sqlite
      .query(
        "update payment_recovery set status = 'processing', attempts = 1, time_next_attempt = null, time_lease_expires = ?, last_error_code = null where id = ?",
      )
      .run(now - 1, leased.id)

    expect(await processPaymentRecoveries({ now }, { apply: async () => undefined, use, transaction })).toMatchObject({
      resolved: 1,
    })
    expect(sqlite.query("select status, attempts from payment_recovery where id = ?").get(leased.id)).toEqual({
      status: "resolved",
      attempts: 2,
    })

    const exhausted = await recordPaymentDeadLetter({ body: payment("3"), now: now + 1 }, { transaction })
    sqlite
      .query("update payment_recovery set attempts = ?, time_next_attempt = ? where id = ?")
      .run(PAYMENT_RECOVERY_MAX_ATTEMPTS - 1, now + 1, exhausted.id)
    expect(
      await processPaymentRecoveries(
        { now: now + 1 },
        {
          apply: async () => {
            throw new Error("persistent failure")
          },
          use,
          transaction,
        },
      ),
    ).toMatchObject({ manualReview: 1, retried: 0 })
    expect(
      sqlite
        .query("select status, attempts, last_error_code, time_next_attempt from payment_recovery where id = ?")
        .get(exhausted.id),
    ).toEqual({
      status: "manual_review",
      attempts: PAYMENT_RECOVERY_MAX_ATTEMPTS,
      last_error_code: "payment_apply_failed",
      time_next_attempt: null,
    })
  })

  test("allows only stored manual-review events to be re-queued", async () => {
    const { sqlite, transaction } = await setup()
    const retryable = await recordPaymentDeadLetter({ body: payment("4"), now }, { transaction })
    sqlite
      .query(
        "update payment_recovery set status = 'manual_review', attempts = ?, last_error_code = ?, time_next_attempt = null, time_lease_expires = null, time_resolved = null where id = ?",
      )
      .run(PAYMENT_RECOVERY_MAX_ATTEMPTS, "payment_apply_failed", retryable.id)

    const retried = await transaction((db) =>
      retryPaymentRecoveryWithDb(db, { recoveryID: retryable.id, now: now + 10 }),
    )
    expect(retried).toMatchObject({
      id: retryable.id,
      status: "pending",
      attempts: 0,
      previousStatus: "manual_review",
      previousAttempts: PAYMENT_RECOVERY_MAX_ATTEMPTS,
      previousLastErrorCode: "payment_apply_failed",
    })
    expect(
      sqlite
        .query(
          "select status, attempts, last_error_code, time_next_attempt, time_lease_expires from payment_recovery where id = ?",
        )
        .get(retryable.id),
    ).toEqual({
      status: "pending",
      attempts: 0,
      last_error_code: null,
      time_next_attempt: now + 10,
      time_lease_expires: null,
    })

    await expect(
      transaction((db) => retryPaymentRecoveryWithDb(db, { recoveryID: retryable.id, now: now + 11 })),
    ).rejects.toMatchObject({ name: "PaymentRecoveryRetryError", code: "invalid_state", currentStatus: "pending" })

    const invalid = await recordPaymentDeadLetter({ body: { broken: true }, now: now + 12 }, { transaction })
    await expect(
      transaction((db) => retryPaymentRecoveryWithDb(db, { recoveryID: invalid.id, now: now + 13 })),
    ).rejects.toMatchObject({ name: "PaymentRecoveryRetryError", code: "invalid_event" })

    await expect(
      transaction((db) =>
        retryPaymentRecoveryWithDb(db, { recoveryID: "prc_01JV5T0G9H5Q3N7S2R8M4K6WXA", now: now + 14 }),
      ),
    ).rejects.toBeInstanceOf(PaymentRecoveryRetryError)
  })
})
