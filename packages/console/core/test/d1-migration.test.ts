import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { resolve } from "node:path"

async function migrationSql() {
  const paths = await migrationPaths()
  return (await Promise.all(paths.map((path) => Bun.file(path).text()))).join("\n")
}

async function migrationPaths() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []

  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) {
    paths.push(path)
  }

  return paths.sort()
}

describe("D1 migration", () => {
  test("applies cleanly to SQLite", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())

    const tables = database
      .query("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name")
      .values()

    expect(tables).toHaveLength(42)
    expect(tables).toContainEqual(["account"])
    expect(tables).toContainEqual(["account_deletion"])
    expect(tables).toContainEqual(["admin_audit_log"])
    expect(tables).toContainEqual(["enterprise_inquiry"])
    expect(tables).toContainEqual(["finance_cost_entry"])
    expect(tables).toContainEqual(["finance_cost_valuation"])
    expect(tables).toContainEqual(["finance_fx_rate"])
    expect(tables).toContainEqual(["finance_payment_settlement"])
    expect(tables).toContainEqual(["newsletter_subscriber"])
    expect(tables).toContainEqual(["payment_event"])
    expect(tables).toContainEqual(["payment_checkout"])
    expect(tables).toContainEqual(["payment_cancellation"])
    expect(tables).toContainEqual(["payment_invoice"])
    expect(tables).toContainEqual(["payment_recovery"])
    expect(tables).toContainEqual(["plan_subscription"])
    expect(tables).toContainEqual(["plan_config_active"])
    expect(tables).toContainEqual(["plan_config_version"])
    expect(tables).toContainEqual(["platform_admin"])
    expect(tables).toContainEqual(["support_ticket"])
    expect(tables).toContainEqual(["support_message"])
    expect(tables).toContainEqual(["workspace"])
  })

  test("keeps the admin audit log immutable", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())
    database
      .query(
        `insert into admin_audit_log
          (id, actor_email, action, outcome, request_id, time_created)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run("aud_01", "owner@mgpt.mn", "admin.request", "success", "request-1", 1)

    expect(() =>
      database.query("update admin_audit_log set outcome = ? where id = ?").run("failure", "aud_01"),
    ).toThrow("admin_audit_log is immutable")
    expect(() => database.query("delete from admin_audit_log where id = ?").run("aud_01")).toThrow(
      "admin_audit_log is immutable",
    )
  })

  test("enforces support ticket and immutable message constraints", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())
    expect(() =>
      database
        .query(
          "insert into support_ticket (id, account_id, requester_email, subject, category, status, priority, lock_version, last_message_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("spt_invalid", "acc_01", "Owner@MGPT.MN", "Тусламж", "technical", "open", "normal", 0, 1),
    ).toThrow()
    database
      .query(
        "insert into support_ticket (id, account_id, requester_email, subject, category, status, priority, lock_version, last_message_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`spt_${"0".repeat(26)}`, "acc_01", "owner@mgpt.mn", "Тусламж", "technical", "open", "normal", 0, 1)
    database
      .query(
        "insert into support_message (id, ticket_id, author_type, account_id, body, internal, time_created) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`spm_${"1".repeat(26)}`, `spt_${"0".repeat(26)}`, "customer", "acc_01", "Сайн байна уу", 0, 1)
    expect(() =>
      database.query("update support_message set body = ? where id = ?").run("changed", `spm_${"1".repeat(26)}`),
    ).toThrow("support_message is immutable")
    expect(() => database.query("delete from support_message where id = ?").run(`spm_${"1".repeat(26)}`)).toThrow(
      "support_message is immutable",
    )
  })

  test("enforces plan configuration singleton, revision, JSON, and immutability constraints", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())
    expect(() =>
      database
        .query("insert into plan_config_version (id, revision, limits, created_by) values (?, ?, ?, ?)")
        .run("pcv_zero", 0, "{}", "adm_01"),
    ).toThrow()
    expect(() =>
      database
        .query("insert into plan_config_version (id, revision, limits, created_by) values (?, ?, ?, ?)")
        .run("pcv_bad_json", 1, "{", "adm_01"),
    ).toThrow()
    database
      .query("insert into plan_config_version (id, revision, limits, created_by) values (?, ?, ?, ?)")
      .run("pcv_01", 1, "{}", "adm_01")
    expect(() =>
      database
        .query("insert into plan_config_version (id, revision, limits, created_by) values (?, ?, ?, ?)")
        .run("pcv_dup", 1, "{}", "adm_01"),
    ).toThrow()
    expect(() =>
      database
        .query("insert into plan_config_active (id, active_version_id, revision, updated_by) values (?, ?, ?, ?)")
        .run(2, "pcv_01", 0, "adm_01"),
    ).toThrow()
    database
      .query("insert into plan_config_active (id, active_version_id, revision, updated_by) values (?, ?, ?, ?)")
      .run(1, "pcv_01", 0, "adm_01")
    expect(() =>
      database.query("update plan_config_version set note = ? where id = ?").run("changed", "pcv_01"),
    ).toThrow("plan_config_version is immutable")
    expect(() => database.query("delete from plan_config_version where id = ?").run("pcv_01")).toThrow(
      "plan_config_version is immutable",
    )
  })

  test("enforces unique and normalized platform administrator identities", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())
    database
      .query(
        `insert into platform_admin (id, email, access_subject, role, status)
         values (?, ?, ?, ?, ?)`,
      )
      .run("adm_01", "owner@mgpt.mn", "subject-1", "owner", "active")

    expect(() =>
      database
        .query(
          `insert into platform_admin (id, email, access_subject, role, status)
           values (?, ?, ?, ?, ?)`,
        )
        .run("adm_02", "owner@mgpt.mn", "subject-2", "support", "active"),
    ).toThrow()
    expect(() =>
      database
        .query(
          `insert into platform_admin (id, email, access_subject, role, status)
           values (?, ?, ?, ?, ?)`,
        )
        .run("adm_03", "support@mgpt.mn", "subject-1", "support", "active"),
    ).toThrow()
    expect(() =>
      database
        .query(
          `insert into platform_admin (id, email, access_subject, role, status)
           values (?, ?, ?, ?, ?)`,
        )
        .run("adm_04", "Owner@MGPT.MN", "subject-4", "owner", "active"),
    ).toThrow()
    expect(() =>
      database
        .query(
          `insert into platform_admin (id, email, access_subject, role, status)
           values (?, ?, ?, ?, ?)`,
        )
        .run("adm_05", "invalid-role@mgpt.mn", "subject-5", "member", "active"),
    ).toThrow()
  })

  test("enforces enum and JSON constraints", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())

    expect(() =>
      database
        .query("insert into auth (id, provider, subject, account_id) values (?, ?, ?, ?)")
        .run("auth-id", "invalid", "subject", "account-id"),
    ).toThrow()

    expect(() =>
      database
        .query("insert into billing (id, workspace_id, balance, subscription) values (?, ?, ?, ?)")
        .run("billing-id", "workspace-id", 0, "{"),
    ).toThrow()

    database
      .query(
        "insert into plan_subscription (id, workspace_id, invoice_id, plan, time_period_start, time_period_end) values (?, ?, ?, ?, ?, ?)",
      )
      .run("sub-1", "workspace-id", "invoice-1", "basic", 1, 2)
    expect(() =>
      database
        .query(
          "insert into plan_subscription (id, workspace_id, invoice_id, plan, time_period_start, time_period_end) values (?, ?, ?, ?, ?, ?)",
        )
        .run("sub-2", "workspace-id", "invoice-2", "pro", 1, 2),
    ).toThrow()

    expect(() =>
      database
        .query(
          `insert into payment_cancellation
            (invoice_id, workspace_id, account_id, request_key, provider, merchant_account_id, external_invoice_id, status, time_requested, time_completed)
           values (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
        )
        .run(
          "inv_constraint",
          "wrk_constraint",
          "acc_constraint",
          "650f7299-0f46-4d09-92b7-3f8338672227",
          "qpay",
          "merchant_constraint",
          "external_constraint",
          1,
          2,
        ),
    ).toThrow()
  })

  test("enforces account suspension state and auth version constraints", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())

    database.query("insert into account (id) values (?)").run("acc_active")
    expect(database.query("select status, auth_version from account where id = ?").get("acc_active")).toEqual({
      status: "active",
      auth_version: 0,
    })

    expect(() =>
      database
        .query(
          "update account set status = 'suspended', suspension_reason = ?, suspended_by = ?, time_suspended = ? where id = ?",
        )
        .run("Дүрэм зөрчсөн хэрэглэгч", "adm_01", 1, "acc_active"),
    ).not.toThrow()
    expect(() => database.query("update account set auth_version = -1 where id = ?").run("acc_active")).toThrow()
    expect(() =>
      database
        .query(
          "insert into account (id, status, suspension_reason, suspended_by, time_suspended) values (?, 'active', ?, ?, ?)",
        )
        .run("acc_invalid_active", "Шалтгаан үлдсэн", "adm_01", 1),
    ).toThrow()
    expect(() =>
      database.query("insert into account (id, status) values (?, 'suspended')").run("acc_invalid_suspended"),
    ).toThrow()
  })

  test("enforces account deletion retry and state constraints", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())

    database
      .query(
        `insert into account_deletion
          (id, account_id, status, attempts, time_eligible)
         values (?, ?, 'requested', 0, ?)`,
      )
      .run("adl_requested", "acc_requested", 1)

    expect(() =>
      database
        .query(
          `insert into account_deletion
            (id, account_id, status, attempts, time_eligible)
           values (?, ?, 'processing', 1, ?)`,
        )
        .run("adl_invalid_processing", "acc_invalid_processing", 1),
    ).toThrow()
    expect(() =>
      database
        .query(
          `insert into account_deletion
            (id, account_id, status, attempts, time_eligible, time_started, last_error_code)
           values (?, ?, 'failed', 6, ?, ?, ?)`,
        )
        .run("adl_invalid_attempts", "acc_invalid_attempts", 1, 1, "account_cleanup_failed"),
    ).toThrow()
    expect(() =>
      database
        .query(
          `insert into account_deletion
            (id, account_id, status, attempts, time_eligible, time_started, last_error_code)
           values (?, ?, 'failed', 1, ?, ?, ?)`,
        )
        .run("adl_invalid_error", "acc_invalid_error", 1, 1, ""),
    ).toThrow()
  })

  test("enforces payment recovery identity, retry, and lifecycle constraints", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())
    const insert = database.query(
      `insert into payment_recovery
        (id, message_hash, provider, merchant_account_id, external_event_id, external_invoice_id,
         payload_hash, event, status, attempts, last_error_code, time_next_attempt, time_lease_expires)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    expect(() =>
      insert.run(
        "prc_invalid_pending",
        "a".repeat(64),
        null,
        null,
        null,
        null,
        null,
        null,
        "pending",
        0,
        null,
        1,
        null,
      ),
    ).toThrow()
    expect(() =>
      insert.run(
        "prc_invalid_attempts",
        "b".repeat(64),
        "qpay",
        "merchant",
        "event",
        "invoice",
        "c".repeat(64),
        "{}",
        "pending",
        7,
        null,
        1,
        null,
      ),
    ).toThrow()
    expect(() =>
      insert.run(
        "prc_invalid_processing",
        "d".repeat(64),
        "qpay",
        "merchant",
        "event",
        "invoice",
        "e".repeat(64),
        "{}",
        "processing",
        1,
        "stale_error",
        null,
        2,
      ),
    ).toThrow()
  })

  test("preserves closed checkout data while adding cancellation support", async () => {
    const target = "20260721194202_abandoned_madame_web"
    const paths = await migrationPaths()
    const targetIndex = paths.findIndex((path) => path.includes(target))
    expect(targetIndex).toBeGreaterThan(0)
    const targetPath = paths[targetIndex]
    if (!targetPath) throw new Error("Cancellation migration is missing")
    const database = new Database(":memory:")
    const before = await Promise.all(paths.slice(0, targetIndex).map((path) => Bun.file(path).text()))
    database.exec(before.join("\n"))

    const insert = database.query(
      `insert into payment_checkout
        (id, workspace_id, account_id, request_key, provider, merchant_account_id, external_invoice_id, purpose, plan, amount, checkout, status, time_expires)
       values (?, ?, ?, ?, 'qpay', 'merchant_upgrade', ?, 'subscription', 'pro', 49000, ?, ?, 9999999999999)`,
    )
    insert.run(
      "inv_upgrade_failed",
      "wrk_upgrade",
      "acc_upgrade",
      "6dfc6b0a-667a-4a2b-8b74-8f2898223895",
      null,
      null,
      "failed",
    )
    const checkout = JSON.stringify({
      provider: "qpay",
      merchantAccountID: "merchant_upgrade",
      externalInvoiceID: "external_expired",
      deepLinks: [],
    })
    insert.run(
      "inv_upgrade_expired",
      "wrk_upgrade",
      "acc_upgrade",
      "c8738102-e019-49cb-98f0-5c480540f70f",
      "external_expired",
      checkout,
      "expired",
    )

    database.exec(await Bun.file(targetPath).text())

    expect(
      database.query("select id, external_invoice_id, checkout, status from payment_checkout order by id").all(),
    ).toEqual([
      { id: "inv_upgrade_expired", external_invoice_id: "external_expired", checkout, status: "expired" },
      { id: "inv_upgrade_failed", external_invoice_id: null, checkout: null, status: "failed" },
    ])
    expect(() =>
      database
        .query(
          `insert into payment_checkout
            (id, workspace_id, account_id, request_key, provider, merchant_account_id, external_invoice_id, purpose, plan, amount, checkout, status, time_expires)
           values (?, ?, ?, ?, 'qpay', 'merchant_upgrade', ?, 'subscription', 'pro', 49000, ?, 'failed', 9999999999999)`,
        )
        .run(
          "inv_failed_verified",
          "wrk_upgrade",
          "acc_upgrade",
          "f0e1c9d6-c02e-42e8-a9ae-4fcf57e1cdd4",
          "external_failed",
          JSON.stringify({
            provider: "qpay",
            merchantAccountID: "merchant_upgrade",
            externalInvoiceID: "external_failed",
            deepLinks: [],
          }),
        ),
    ).not.toThrow()
  })
})
