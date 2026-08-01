import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import {
  ACCOUNT_DELETION_RETRY_MS,
  AccountDeletionError,
  cancelAccountDeletion,
  getAccountDeletion,
  processEligibleAccountDeletions,
  requestAccountDeletion,
} from "../src/account-deletion"
import type { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

const now = 2_000_000_000_000
const accountID = "acc_account_deletion"
const workspaceID = "wrk_account_deletion"
const userID = "usr_account_deletion"
const keyID = "key_account_deletion"

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
  const transaction = <T>(callback: (value: Database.TxOrDb) => Promise<T>) => callback(db)

  sqlite.query("insert into account (id) values (?)").run(accountID)
  sqlite
    .query("insert into auth (id, provider, subject, account_id) values (?, ?, ?, ?)")
    .run("auth_account_email", "email", "owner@mgpt.mn", accountID)
  sqlite
    .query("insert into auth (id, provider, subject, account_id) values (?, ?, ?, ?)")
    .run("auth_account_github", "github", "github-subject", accountID)
  sqlite.query("insert into workspace (id, name) values (?, ?)").run(workspaceID, "Deletion test")
  sqlite
    .query("insert into user (id, workspace_id, account_id, email, name, role) values (?, ?, ?, ?, ?, ?)")
    .run(userID, workspaceID, accountID, "owner@mgpt.mn", "Owner", "admin")
  sqlite
    .query("insert into key (id, workspace_id, name, key, user_id) values (?, ?, ?, ?, ?)")
    .run(keyID, workspaceID, "Delete me", "mgpt_delete_me", userID)
  sqlite
    .query(
      "insert into payment_checkout (id, workspace_id, account_id, request_key, provider, merchant_account_id, purpose, plan, amount, time_expires) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "checkout_account_deletion",
      workspaceID,
      accountID,
      "request_account_deletion",
      "qpay",
      "merchant_account_deletion",
      "subscription",
      "basic",
      10_000,
      now + 60_000,
    )
  return { sqlite, db, use, transaction }
}

describe("account deletion lifecycle", () => {
  test("schedules idempotently, supports cancellation, and reopens a cancelled request", async () => {
    const { use, transaction } = await setup()
    const first = await requestAccountDeletion({ accountID, graceMs: 60_000 }, { now: () => now, transaction })
    expect(first).toMatchObject({
      accountID,
      status: "requested",
      eligibleAt: now + 60_000,
      changed: true,
    })

    const replay = await requestAccountDeletion(
      { accountID, graceMs: 120_000 },
      { now: () => now + 1_000, transaction },
    )
    expect(replay).toMatchObject({
      id: first.id,
      status: "requested",
      eligibleAt: now + 60_000,
      changed: false,
    })

    const cancelled = await cancelAccountDeletion({ accountID }, { now: () => now + 2_000, transaction })
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelledAt: now + 2_000,
      changed: true,
    })
    expect(await cancelAccountDeletion({ accountID }, { now: () => now + 3_000, transaction })).toMatchObject({
      status: "cancelled",
      changed: false,
    })

    const reopened = await requestAccountDeletion(
      { accountID, graceMs: 30_000 },
      { now: () => now + 4_000, transaction },
    )
    expect(reopened).toMatchObject({
      id: first.id,
      status: "requested",
      attempts: 0,
      eligibleAt: now + 34_000,
      changed: true,
    })
    expect(await getAccountDeletion({ accountID }, { use })).toEqual({ ...reopened, changed: false })
  })

  test("requires another administrator before leaving a shared workspace", async () => {
    const { sqlite, transaction } = await setup()
    const otherAccountID = "acc_account_deletion_other"
    const otherUserID = "usr_account_deletion_other"
    sqlite.query("insert into account (id) values (?)").run(otherAccountID)
    sqlite
      .query("insert into user (id, workspace_id, account_id, email, name, role) values (?, ?, ?, ?, ?, ?)")
      .run(otherUserID, workspaceID, otherAccountID, "member@mgpt.mn", "Member", "member")

    const rejected = await requestAccountDeletion({ accountID }, { now: () => now, transaction }).catch(
      (error) => error,
    )
    expect(rejected).toMatchObject({
      code: "workspace_admin_required",
    } satisfies Partial<AccountDeletionError>)

    sqlite.query("update user set role = 'admin' where id = ?").run(otherUserID)
    expect(await requestAccountDeletion({ accountID }, { now: () => now, transaction })).toMatchObject({
      accountID,
      status: "requested",
      changed: true,
    })
  })

  test("rechecks shared workspace administrators when cleanup starts", async () => {
    const { sqlite, use, transaction } = await setup()
    const otherAccountID = "acc_account_deletion_race"
    const otherUserID = "usr_account_deletion_race"
    sqlite.query("insert into account (id) values (?)").run(otherAccountID)
    sqlite
      .query("insert into user (id, workspace_id, account_id, email, name, role) values (?, ?, ?, ?, ?, ?)")
      .run(otherUserID, workspaceID, otherAccountID, "admin@mgpt.mn", "Other admin", "admin")
    await requestAccountDeletion({ accountID, graceMs: 0 }, { now: () => now, transaction })

    sqlite.query("update user set role = 'member' where id = ?").run(otherUserID)
    expect(await processEligibleAccountDeletions({ now }, { use, transaction })).toEqual({
      processed: 0,
      failed: 1,
      skipped: 0,
      truncated: false,
    })
    expect(await getAccountDeletion({ accountID }, { use })).toMatchObject({
      status: "failed",
      attempts: 1,
    })
    expect(sqlite.query("select time_deleted from account where id = ?").get(accountID)).toEqual({
      time_deleted: null,
    })

    sqlite.query("update user set role = 'admin' where id = ?").run(otherUserID)
    expect(
      await processEligibleAccountDeletions({ now: now + ACCOUNT_DELETION_RETRY_MS }, { use, transaction }),
    ).toEqual({
      processed: 1,
      failed: 0,
      skipped: 0,
      truncated: false,
    })
  })

  test("revokes account access atomically after the grace period while retaining payment records", async () => {
    const { sqlite, use, transaction } = await setup()
    await requestAccountDeletion({ accountID, graceMs: 1_000 }, { now: () => now, transaction })

    expect(await processEligibleAccountDeletions({ now: now + 999 }, { use, transaction })).toEqual({
      processed: 0,
      failed: 0,
      skipped: 0,
      truncated: false,
    })
    expect(await processEligibleAccountDeletions({ now: now + 1_000 }, { use, transaction })).toEqual({
      processed: 1,
      failed: 0,
      skipped: 0,
      truncated: false,
    })

    expect(sqlite.query("select auth_version, time_deleted from account where id = ?").get(accountID)).toEqual({
      auth_version: 1,
      time_deleted: now + 1_000,
    })
    expect(sqlite.query("select count(*) as count from auth where account_id = ?").get(accountID)).toEqual({ count: 0 })
    expect(sqlite.query("select account_id, email, name, time_deleted from user where id = ?").get(userID)).toEqual({
      account_id: null,
      email: null,
      name: "",
      time_deleted: now + 1_000,
    })
    expect(sqlite.query("select name, key, time_used, time_deleted from key where id = ?").get(keyID)).toEqual({
      name: "",
      key: `revoked:${keyID}`,
      time_used: null,
      time_deleted: now + 1_000,
    })
    expect(sqlite.query("select count(*) as count from key where key = ?").get("mgpt_delete_me")).toEqual({ count: 0 })
    expect(
      sqlite.query("select account_id, amount from payment_checkout where id = ?").get("checkout_account_deletion"),
    ).toEqual({
      account_id: accountID,
      amount: 10_000,
    })
    expect(await getAccountDeletion({ accountID }, { use })).toMatchObject({
      status: "completed",
      attempts: 1,
      completedAt: now + 1_000,
    })
    expect(await processEligibleAccountDeletions({ now: now + 2_000 }, { use, transaction })).toEqual({
      processed: 0,
      failed: 0,
      skipped: 0,
      truncated: false,
    })
    const rejected = await cancelAccountDeletion({ accountID }, { now: () => now + 2_000, transaction }).catch(
      (error) => error,
    )
    expect(rejected).toMatchObject({
      code: "too_late",
    } satisfies Partial<AccountDeletionError>)
  })

  test("records only a bounded error code and retries without exposing failure details", async () => {
    const { sqlite, use, transaction } = await setup()
    await requestAccountDeletion({ accountID, graceMs: 0 }, { now: () => now, transaction })

    const failed = await processEligibleAccountDeletions(
      { now },
      {
        use,
        transaction,
        remove: async () => {
          throw new Error("provider-secret=must-not-be-persisted")
        },
      },
    )
    expect(failed).toEqual({ processed: 0, failed: 1, skipped: 0, truncated: false })
    expect(
      sqlite
        .query("select status, attempts, last_error_code, time_eligible from account_deletion where account_id = ?")
        .get(accountID),
    ).toEqual({
      status: "failed",
      attempts: 1,
      last_error_code: "account_cleanup_failed",
      time_eligible: now + ACCOUNT_DELETION_RETRY_MS,
    })
    expect(await getAccountDeletion({ accountID }, { use })).not.toHaveProperty("lastErrorCode")

    expect(
      await processEligibleAccountDeletions({ now: now + ACCOUNT_DELETION_RETRY_MS - 1 }, { use, transaction }),
    ).toEqual({ processed: 0, failed: 0, skipped: 0, truncated: false })
    expect(
      await processEligibleAccountDeletions({ now: now + ACCOUNT_DELETION_RETRY_MS }, { use, transaction }),
    ).toEqual({ processed: 1, failed: 0, skipped: 0, truncated: false })
    expect(await getAccountDeletion({ accountID }, { use })).toMatchObject({
      status: "completed",
      attempts: 2,
    })
  })
})
