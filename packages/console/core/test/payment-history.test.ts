import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { Database } from "../src/drizzle"
import { getWorkspacePaymentHistoryWithDb } from "../src/payment-history"

const WORKSPACE_A = "wrk_payment_history_a"
const WORKSPACE_B = "wrk_payment_history_b"
const INVOICE_A = "inv_01JV5T0G9H5Q3N7S2R8M4K6WXA"
const INVOICE_B = "inv_01JV5T0G9H5Q3N7S2R8M4K6WXB"
const INVOICE_C = "inv_01JV5T0G9H5Q3N7S2R8M4K6WXC"
const INVOICE_D = "inv_01JV5T0G9H5Q3N7S2R8M4K6WXD"

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

describe("workspace payment history", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun SQLite implements the D1 subset used by the query
    const db = drizzle({ client: sqlite }) as unknown as Database.TxOrDb

    const insert = sqlite.query(
      `insert into payment_invoice
        (id, workspace_id, provider, merchant_account_id, external_invoice_id, purpose, plan, amount,
          currency, status, time_expires, time_verified, time_refunded, time_created, time_deleted)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run(
      INVOICE_A,
      WORKSPACE_A,
      "qpay",
      "qpay_private_merchant",
      "qpay_private_invoice",
      "subscription",
      "basic",
      19_000,
      "MNT",
      "paid",
      2_000,
      1_500,
      null,
      1_000,
      null,
    )
    insert.run(
      INVOICE_B,
      WORKSPACE_A,
      "bonum",
      "bonum_private_terminal",
      "bonum_private_invoice",
      "subscription",
      "pro",
      49_000,
      "MNT",
      "refunded",
      4_000,
      3_500,
      3_800,
      3_000,
      null,
    )
    insert.run(
      INVOICE_C,
      WORKSPACE_B,
      "qpay",
      "other_merchant",
      "other_invoice",
      "subscription",
      "max",
      99_000,
      "MNT",
      "pending",
      5_000,
      null,
      null,
      4_000,
      null,
    )
    insert.run(
      INVOICE_D,
      WORKSPACE_A,
      "qpay",
      "deleted_merchant",
      "deleted_invoice",
      "subscription",
      "max",
      99_000,
      "MNT",
      "cancelled",
      6_000,
      null,
      null,
      5_000,
      5_500,
    )
    return { db }
  }

  test("returns only the workspace's visible invoices in newest-first order", async () => {
    const { db } = await fixture()
    const history = await getWorkspacePaymentHistoryWithDb(db, WORKSPACE_A, 25)

    expect(history).toEqual([
      {
        invoiceID: INVOICE_B,
        provider: "bonum",
        purpose: "subscription",
        plan: "pro",
        amount: 49_000,
        currency: "MNT",
        status: "refunded",
        createdAt: 3_000,
        expiresAt: 4_000,
        verifiedAt: 3_500,
        refundedAt: 3_800,
      },
      {
        invoiceID: INVOICE_A,
        provider: "qpay",
        purpose: "subscription",
        plan: "basic",
        amount: 19_000,
        currency: "MNT",
        status: "paid",
        createdAt: 1_000,
        expiresAt: 2_000,
        verifiedAt: 1_500,
        refundedAt: null,
      },
    ])
    expect(JSON.stringify(history)).not.toContain("private")
  })

  test("enforces a bounded result without crossing workspaces", async () => {
    const { db } = await fixture()

    expect(await getWorkspacePaymentHistoryWithDb(db, WORKSPACE_A, 1)).toHaveLength(1)
    expect(await getWorkspacePaymentHistoryWithDb(db, WORKSPACE_B, 25)).toEqual([
      expect.objectContaining({ invoiceID: INVOICE_C, status: "pending" }),
    ])
    const invalidLimit = await getWorkspacePaymentHistoryWithDb(db, WORKSPACE_A, 51).catch((error) => error)
    const invalidWorkspace = await getWorkspacePaymentHistoryWithDb(db, "workspace_a", 25).catch((error) => error)
    expect(invalidLimit).toBeInstanceOf(Error)
    expect(invalidWorkspace).toBeInstanceOf(Error)
  })
})
