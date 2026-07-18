import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { eq, sql } from "drizzle-orm"
import { resolve } from "node:path"
import {
  ApplyPaymentEventSchema,
  applyPaymentEventWithDb,
  paymentTransition,
  RecordPaymentInvoiceSchema,
  recordPaymentInvoiceWithDb,
  type PaymentTransitionEffect,
} from "../src/payment-ledger"
import { BillingTable, PaymentInvoiceTable } from "../src/schema/billing.sql"
import { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

const payloadHash = (character: string) => character.repeat(64)

describe("provider-neutral payment ledger", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    const db = drizzleDb as unknown as Database.TxOrDb
    const workspaceID = "wrk_payment_test"
    const merchantAccountID = "merchant_payment_test"
    sqlite.query("insert into workspace (id, name) values (?, ?)").run(workspaceID, "Payment test")
    sqlite
      .query("insert into billing (id, workspace_id, balance) values (?, ?, ?)")
      .run("bil_payment_test", workspaceID, 0)

    async function transaction<T>(callback: (tx: Database.TxOrDb) => Promise<T>) {
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

    return { sqlite, db, workspaceID, merchantAccountID, transaction }
  }

  test("permits only valid payment lifecycle transitions", () => {
    expect(paymentTransition("created", "pending")).toBe("applied")
    expect(paymentTransition("created", "paid")).toBe("applied")
    expect(paymentTransition("created", "refunded")).toBe("rejected")
    expect(paymentTransition("pending", "paid")).toBe("applied")
    expect(paymentTransition("paid", "refunded")).toBe("applied")
    expect(paymentTransition("paid", "expired")).toBe("rejected")
    expect(paymentTransition("refunded", "paid")).toBe("rejected")
    expect(paymentTransition("cancelled", "cancelled")).toBe("noop")
  })

  test("records one immutable invoice for a provider invoice ID", async () => {
    const { sqlite, db, workspaceID, merchantAccountID } = await fixture()
    const invoice = {
      id: "inv_payment_test",
      workspaceID,
      provider: "qpay" as const,
      merchantAccountID,
      externalInvoiceID: "qpay_invoice_1",
      purpose: "subscription" as const,
      plan: "pro" as const,
      amount: 39_000,
      currency: "MNT" as const,
      expiresAt: Date.UTC(2026, 6, 20),
    }

    await expect(recordPaymentInvoiceWithDb(db, invoice)).resolves.toMatchObject({ kind: "created" })
    await expect(recordPaymentInvoiceWithDb(db, invoice)).resolves.toMatchObject({ kind: "duplicate" })
    await expect(recordPaymentInvoiceWithDb(db, { ...invoice, amount: 59_000 })).rejects.toThrow(
      "Payment invoice replay conflicts",
    )
    expect(sqlite.query("select count(*) as count from payment_invoice").get()).toEqual({ count: 1 })
  })

  test("applies paid and refunded effects once across callback replays", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    await recordPaymentInvoiceWithDb(db, {
      workspaceID,
      provider: "bonum",
      merchantAccountID,
      externalInvoiceID: "bonum_invoice_1",
      purpose: "credit",
      amount: 20_000,
    })

    const effect: PaymentTransitionEffect = async (input) => {
      if (input.event.type !== "paid" && input.event.type !== "refunded") return
      await input.db
        .update(BillingTable)
        .set({
          balance:
            input.event.type === "paid" ? sql`${BillingTable.balance} + 100` : sql`${BillingTable.balance} - 100`,
        })
        .where(eq(BillingTable.workspaceID, input.invoice.workspace_id))
    }
    const apply = (input: Parameters<typeof applyPaymentEventWithDb>[1]) =>
      transaction((tx) => applyPaymentEventWithDb(tx, input, effect))

    await expect(
      apply({
        provider: "bonum",
        merchantAccountID,
        externalEventID: "event_pending",
        externalInvoiceID: "bonum_invoice_1",
        type: "pending",
        payloadHash: payloadHash("a"),
        occurredAt: 1,
      }),
    ).resolves.toMatchObject({ kind: "applied", invoice: { status: "pending" } })
    const paid = {
      provider: "bonum" as const,
      merchantAccountID,
      externalEventID: "event_paid",
      externalInvoiceID: "bonum_invoice_1",
      externalPaymentID: "bonum_payment_1",
      amount: 20_000,
      currency: "MNT" as const,
      type: "paid" as const,
      payloadHash: payloadHash("b"),
      occurredAt: 2,
    }
    await expect(apply(paid)).resolves.toMatchObject({ kind: "applied", invoice: { status: "paid" } })
    await expect(apply(paid)).resolves.toMatchObject({ kind: "duplicate" })
    await expect(apply({ ...paid, externalEventID: "event_paid_again" })).resolves.toMatchObject({ kind: "noop" })
    await expect(
      apply({
        ...paid,
        externalEventID: "event_expired_after_paid",
        type: "expired",
        payloadHash: payloadHash("c"),
      }),
    ).resolves.toMatchObject({ kind: "rejected", invoice: { status: "paid" } })

    const refunded = {
      ...paid,
      externalEventID: "event_refunded",
      type: "refunded" as const,
      payloadHash: payloadHash("d"),
      occurredAt: 3,
    }
    await expect(apply(refunded)).resolves.toMatchObject({ kind: "applied", invoice: { status: "refunded" } })
    await expect(apply(refunded)).resolves.toMatchObject({ kind: "duplicate" })
    await expect(apply({ ...refunded, externalEventID: "event_refunded_again" })).resolves.toMatchObject({
      kind: "noop",
    })

    expect(sqlite.query("select balance from billing").get()).toEqual({ balance: 0 })
    expect(
      sqlite
        .query(
          "select status, external_payment_id, time_verified, time_refunded from payment_invoice where external_invoice_id = ?",
        )
        .get("bonum_invoice_1"),
    ).toEqual({
      status: "refunded",
      external_payment_id: "bonum_payment_1",
      time_verified: 2,
      time_refunded: 3,
    })
    expect(
      sqlite.query("select outcome, count(*) as count from payment_event group by outcome order by outcome").all(),
    ).toEqual([
      { outcome: "applied", count: 3 },
      { outcome: "noop", count: 2 },
      { outcome: "rejected", count: 1 },
    ])
  })

  test("rolls back the event and transition when its side effect fails", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    await recordPaymentInvoiceWithDb(db, {
      workspaceID,
      provider: "qpay",
      merchantAccountID,
      externalInvoiceID: "qpay_invoice_rollback",
      purpose: "subscription",
      plan: "basic",
      amount: 19_000,
    })
    const event = {
      provider: "qpay" as const,
      merchantAccountID,
      externalEventID: "event_rollback",
      externalInvoiceID: "qpay_invoice_rollback",
      externalPaymentID: "qpay_payment_rollback",
      amount: 19_000,
      currency: "MNT" as const,
      type: "paid" as const,
      payloadHash: payloadHash("e"),
      occurredAt: 4,
    }

    await expect(
      transaction((tx) =>
        applyPaymentEventWithDb(tx, event, async () => {
          throw new Error("settlement failed")
        }),
      ),
    ).rejects.toThrow("settlement failed")
    expect(
      sqlite.query("select status from payment_invoice where external_invoice_id = ?").get(event.externalInvoiceID),
    ).toEqual({ status: "created" })
    expect(sqlite.query("select count(*) as count from payment_event").get()).toEqual({ count: 0 })

    await expect(transaction((tx) => applyPaymentEventWithDb(tx, event))).resolves.toMatchObject({
      kind: "applied",
      invoice: { status: "paid" },
    })
  })

  test("does not let one provider payment settle two invoices", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    for (const externalInvoiceID of ["qpay_invoice_a", "qpay_invoice_b"]) {
      await recordPaymentInvoiceWithDb(db, {
        workspaceID,
        provider: "qpay",
        merchantAccountID,
        externalInvoiceID,
        purpose: "subscription",
        plan: "max",
        amount: 99_000,
      })
    }
    const paid = (externalInvoiceID: string, externalEventID: string) => ({
      provider: "qpay" as const,
      merchantAccountID,
      externalEventID,
      externalInvoiceID,
      externalPaymentID: "qpay_shared_payment",
      amount: 99_000,
      currency: "MNT" as const,
      type: "paid" as const,
      payloadHash: payloadHash(externalEventID.endsWith("a") ? "f" : "0"),
      occurredAt: 5,
    })

    await transaction((tx) => applyPaymentEventWithDb(tx, paid("qpay_invoice_a", "event_a")))
    await expect(transaction((tx) => applyPaymentEventWithDb(tx, paid("qpay_invoice_b", "event_b")))).rejects.toThrow()

    expect(
      sqlite.query("select external_invoice_id, status from payment_invoice order by external_invoice_id").all(),
    ).toEqual([
      { external_invoice_id: "qpay_invoice_a", status: "paid" },
      { external_invoice_id: "qpay_invoice_b", status: "created" },
    ])
    expect(sqlite.query("select count(*) as count from payment_event").get()).toEqual({ count: 1 })
    expect(
      await db
        .select({ id: PaymentInvoiceTable.id })
        .from(PaymentInvoiceTable)
        .where(eq(PaymentInvoiceTable.external_payment_id, "qpay_shared_payment")),
    ).toHaveLength(1)
  })

  test("rejects mismatched settlement amounts and invalid timestamps", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    await recordPaymentInvoiceWithDb(db, {
      workspaceID,
      provider: "qpay",
      merchantAccountID,
      externalInvoiceID: "qpay_invoice_amount",
      purpose: "credit",
      amount: 5_000,
    })

    await expect(
      transaction((tx) =>
        applyPaymentEventWithDb(tx, {
          provider: "qpay",
          merchantAccountID,
          externalEventID: "event_wrong_amount",
          externalInvoiceID: "qpay_invoice_amount",
          externalPaymentID: "qpay_payment_amount",
          amount: 4_999,
          currency: "MNT",
          type: "paid",
          payloadHash: payloadHash("1"),
          occurredAt: 6,
        }),
      ),
    ).rejects.toThrow("amount or currency does not match")

    expect(sqlite.query("select status from payment_invoice").get()).toEqual({ status: "created" })
    expect(sqlite.query("select count(*) as count from payment_event").get()).toEqual({ count: 0 })
    expect(
      ApplyPaymentEventSchema.safeParse({
        provider: "qpay",
        merchantAccountID,
        externalEventID: "event_bad_currency",
        externalInvoiceID: "qpay_invoice_amount",
        externalPaymentID: "qpay_payment_amount",
        amount: 5_000,
        currency: "USD",
        type: "paid",
        payloadHash: payloadHash("2"),
        occurredAt: 7,
      }).success,
    ).toBe(false)
    expect(
      RecordPaymentInvoiceSchema.safeParse({
        workspaceID,
        provider: "qpay",
        merchantAccountID,
        externalInvoiceID: "qpay_invoice_bad_date",
        purpose: "credit",
        amount: 1,
        expiresAt: 8_640_000_000_000_001,
      }).success,
    ).toBe(false)
  })

  test("scopes provider identifiers to one merchant account", async () => {
    const { sqlite, db, workspaceID, transaction } = await fixture()
    const externalInvoiceID = "shared_provider_invoice"
    for (const merchantAccountID of ["merchant_a", "merchant_b"]) {
      await recordPaymentInvoiceWithDb(db, {
        workspaceID,
        provider: "qpay",
        merchantAccountID,
        externalInvoiceID,
        purpose: "credit",
        amount: 10_000,
      })
      await transaction((tx) =>
        applyPaymentEventWithDb(tx, {
          provider: "qpay",
          merchantAccountID,
          externalEventID: "shared_provider_event",
          externalInvoiceID,
          externalPaymentID: "shared_provider_payment",
          amount: 10_000,
          currency: "MNT",
          type: "paid",
          payloadHash: payloadHash(merchantAccountID.endsWith("a") ? "3" : "4"),
          occurredAt: 8,
        }),
      )
    }

    expect(
      sqlite
        .query(
          "select merchant_account_id, status from payment_invoice where external_invoice_id = ? order by merchant_account_id",
        )
        .all(externalInvoiceID),
    ).toEqual([
      { merchant_account_id: "merchant_a", status: "paid" },
      { merchant_account_id: "merchant_b", status: "paid" },
    ])
    expect(sqlite.query("select count(*) as count from payment_event").get()).toEqual({ count: 2 })
  })
})
