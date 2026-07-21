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

    expect(tables).toHaveLength(30)
    expect(tables).toContainEqual(["account"])
    expect(tables).toContainEqual(["enterprise_inquiry"])
    expect(tables).toContainEqual(["newsletter_subscriber"])
    expect(tables).toContainEqual(["payment_event"])
    expect(tables).toContainEqual(["payment_checkout"])
    expect(tables).toContainEqual(["payment_cancellation"])
    expect(tables).toContainEqual(["payment_invoice"])
    expect(tables).toContainEqual(["plan_subscription"])
    expect(tables).toContainEqual(["workspace"])
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
