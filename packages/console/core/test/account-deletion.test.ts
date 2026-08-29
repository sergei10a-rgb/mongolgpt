import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import {
  ACCOUNT_DELETION_OPERATIONAL_RETENTION_MS,
  ACCOUNT_DELETION_RETRY_MS,
  AccountDeletionError,
  cancelAccountDeletion,
  getAccountDeletion,
  processEligibleAccountDeletions,
  purgeCompletedAccountDeletions,
  requestAccountDeletion,
} from "../src/account-deletion"
import type { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

const now = 2_000_000_000_000
const accountID = "acc_account_deletion"
const workspaceID = "wrk_account_deletion"
const userID = "usr_account_deletion"
const invitationID = "usr_account_deletion_invitation"
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
    .query("insert into user (id, workspace_id, email, name, role) values (?, ?, ?, ?, ?)")
    .run(invitationID, workspaceID, "invited@mgpt.mn", "Invited user", "member")
  sqlite
    .query("insert into key (id, workspace_id, name, key, user_id) values (?, ?, ?, ?, ?)")
    .run(keyID, workspaceID, "Delete me", "mgpt_delete_me", userID)
  sqlite.query("insert into key_rate_limit (key, interval, count) values (?, ?, ?)").run("mgpt_delete_me", "day", 1)
  sqlite
    .query("insert into provider (id, workspace_id, provider, credentials) values (?, ?, ?, ?)")
    .run("prv_account_deletion", workspaceID, "openrouter", '{"apiKey":"provider-secret"}')
  sqlite
    .query("insert into subscription (id, workspace_id, user_id) values (?, ?, ?)")
    .run("sub_account_deletion", workspaceID, userID)
  sqlite
    .query("insert into lite (id, workspace_id, user_id) values (?, ?, ?)")
    .run("lit_account_deletion", workspaceID, userID)
  sqlite
    .query(
      "insert into usage (id, workspace_id, user_id, model, provider, input_tokens, output_tokens, cost, key_id, session_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("usg_account_deletion", workspaceID, userID, "test-model", "openrouter", 10, 20, 0, keyID, "session-secret")
  sqlite
    .query("insert into newsletter_subscriber (email, consent_version, time_consented) values (?, ?, ?)")
    .run("owner@mgpt.mn", "v1", now)
  sqlite
    .query("insert into referral (id, workspace_id, invitee_account_id) values (?, ?, ?)")
    .run("ref_account_deletion", workspaceID, accountID)
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
  sqlite
    .query(
      "insert into payment_cancellation (invoice_id, workspace_id, account_id, request_key, provider, merchant_account_id, external_invoice_id, time_requested) values (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "inv_account_deletion",
      workspaceID,
      accountID,
      "cancel_account_deletion",
      "qpay",
      "merchant_account_deletion",
      "external_account_deletion",
      now,
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

  test("revokes access, scrubs sole-workspace secrets, and pseudonymizes retained payment records", async () => {
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
    expect(sqlite.query("select count(*) as count from key_rate_limit where key = ?").get("mgpt_delete_me")).toEqual({
      count: 0,
    })
    expect(sqlite.query("select user_id, key_id, session_id from usage where id = ?").get("usg_account_deletion")).toEqual({
      user_id: null,
      key_id: null,
      session_id: null,
    })
    expect(
      sqlite.query("select credentials, time_deleted from provider where id = ?").get("prv_account_deletion"),
    ).toEqual({
      credentials: "",
      time_deleted: now + 1_000,
    })
    expect(sqlite.query("select name, slug, time_deleted from workspace where id = ?").get(workspaceID)).toEqual({
      name: "",
      slug: null,
      time_deleted: now + 1_000,
    })
    expect(
      sqlite.query("select account_id, email, name, time_deleted from user where id = ?").get(invitationID),
    ).toEqual({ account_id: null, email: null, name: "", time_deleted: now + 1_000 })
    expect(sqlite.query("select time_deleted from subscription where id = ?").get("sub_account_deletion")).toEqual({
      time_deleted: now + 1_000,
    })
    expect(sqlite.query("select time_deleted from lite where id = ?").get("lit_account_deletion")).toEqual({
      time_deleted: now + 1_000,
    })
    expect(
      sqlite.query("select count(*) as count from newsletter_subscriber where email = ?").get("owner@mgpt.mn"),
    ).toEqual({ count: 0 })

    const checkout = sqlite
      .query("select account_id, request_key, status, checkout, amount from payment_checkout where id = ?")
      .get("checkout_account_deletion")
    expect(checkout).toMatchObject({
      request_key: "deleted:checkout_account_deletion",
      status: "expired",
      checkout: null,
      amount: 10_000,
    })
    expect(checkout).not.toMatchObject({ account_id: accountID })
    if (
      typeof checkout !== "object" ||
      checkout === null ||
      !("account_id" in checkout) ||
      typeof checkout.account_id !== "string"
    ) {
      throw new Error("Expected pseudonymous checkout account")
    }
    const pseudonymousAccountID = checkout.account_id
    expect(
      sqlite
        .query(
          "select account_id, request_key, status, error_code, time_completed from payment_cancellation where invoice_id = ?",
        )
        .get("inv_account_deletion"),
    ).toEqual({
      account_id: pseudonymousAccountID,
      request_key: "deleted:inv_account_deletion",
      status: "failed",
      error_code: "account_deleted",
      time_completed: now + 1_000,
    })
    expect(
      sqlite.query("select invitee_account_id, time_deleted from referral where id = ?").get("ref_account_deletion"),
    ).toBeNull()
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

  test("keeps shared workspace credentials while removing only the departing account", async () => {
    const { sqlite, use, transaction } = await setup()
    const otherAccountID = "acc_account_deletion_shared"
    const otherUserID = "usr_account_deletion_shared"
    sqlite.query("insert into account (id) values (?)").run(otherAccountID)
    sqlite
      .query("insert into user (id, workspace_id, account_id, email, name, role) values (?, ?, ?, ?, ?, ?)")
      .run(otherUserID, workspaceID, otherAccountID, "shared@mgpt.mn", "Shared admin", "admin")

    await requestAccountDeletion({ accountID, graceMs: 0 }, { now: () => now, transaction })
    expect(await processEligibleAccountDeletions({ now }, { use, transaction })).toEqual({
      processed: 1,
      failed: 0,
      skipped: 0,
      truncated: false,
    })
    expect(
      sqlite.query("select credentials, time_deleted from provider where id = ?").get("prv_account_deletion"),
    ).toEqual({ credentials: '{"apiKey":"provider-secret"}', time_deleted: null })
    expect(sqlite.query("select name, time_deleted from workspace where id = ?").get(workspaceID)).toEqual({
      name: "Deletion test",
      time_deleted: null,
    })
    expect(sqlite.query("select account_id, time_deleted from user where id = ?").get(otherUserID)).toEqual({
      account_id: otherAccountID,
      time_deleted: null,
    })
    const sharedCheckout = sqlite
      .query("select account_id, request_key, status from payment_checkout where id = ?")
      .get("checkout_account_deletion")
    expect(sharedCheckout).toMatchObject({
      request_key: "deleted:checkout_account_deletion",
      status: "creating",
    })
    expect(sharedCheckout).not.toMatchObject({ account_id: accountID })
    expect(
      sqlite
        .query("select account_id, request_key, status from payment_cancellation where invoice_id = ?")
        .get("inv_account_deletion"),
    ).toMatchObject({ request_key: "deleted:inv_account_deletion", status: "requested" })
    const sharedReferral = sqlite
      .query("select invitee_account_id, time_deleted from referral where id = ?")
      .get("ref_account_deletion")
    expect(sharedReferral).not.toMatchObject({ invitee_account_id: accountID })
    expect(sharedReferral).toMatchObject({ time_deleted: now })
  })

  test("detaches completed deletion records and removes tombstone accounts after 30 days", async () => {
    const { sqlite, use, transaction } = await setup()
    await requestAccountDeletion({ accountID, graceMs: 0 }, { now: () => now, transaction })
    await processEligibleAccountDeletions({ now }, { use, transaction })

    expect(
      await purgeCompletedAccountDeletions(
        { now: now + ACCOUNT_DELETION_OPERATIONAL_RETENTION_MS - 1 },
        { use, transaction },
      ),
    ).toEqual({ purged: 0, skipped: 0, truncated: false })
    expect(
      await purgeCompletedAccountDeletions(
        { now: now + ACCOUNT_DELETION_OPERATIONAL_RETENTION_MS },
        { use, transaction },
      ),
    ).toEqual({ purged: 1, skipped: 0, truncated: false })
    expect(sqlite.query("select count(*) as count from account where id = ?").get(accountID)).toEqual({ count: 0 })
    const operation = sqlite.query("select account_id, time_deleted from account_deletion where id like 'adl_%'").get()
    expect(operation).not.toMatchObject({ account_id: accountID })
    expect(operation).toMatchObject({ time_deleted: now + ACCOUNT_DELETION_OPERATIONAL_RETENTION_MS })
    expect(await getAccountDeletion({ accountID }, { use })).toBeUndefined()
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
