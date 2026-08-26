import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import type { Database } from "../src/drizzle"
import { recordFinancePaymentSettlementWithDb } from "../src/finance-settlement"
import { applyPaymentEventWithDb, recordPaymentInvoiceWithDb } from "../src/payment-ledger"
import * as schema from "../src/schema-d1"

// oxlint-disable typescript-eslint/await-thenable -- Bun's async expect matchers are thenable at runtime.

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

const hash = (character: string) => character.repeat(64)
const effectiveAt = Date.UTC(2026, 6, 30, 1)

describe("provider payment settlement ledger", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Test drivers share this schema contract.
    const db = drizzleDb as unknown as Database.TxOrDb
    sqlite.query("insert into workspace (id, name) values (?, ?)").run("wrk_settlement", "Settlement test")
    return { sqlite, db }
  }

  async function paidInvoice(input: {
    db: Database.TxOrDb
    provider: "qpay" | "bonum"
    suffix: string
    amount: number
  }) {
    const merchantAccountID = `merchant_${input.suffix}`
    const externalInvoiceID = `external_invoice_${input.suffix}`
    const externalPaymentID = `external_payment_${input.suffix}`
    const invoiceID = `inv_${input.suffix}`
    const eventID = `pev_${input.suffix}_paid`
    await recordPaymentInvoiceWithDb(input.db, {
      id: invoiceID,
      workspaceID: "wrk_settlement",
      provider: input.provider,
      merchantAccountID,
      externalInvoiceID,
      purpose: "credit",
      amount: input.amount,
      currency: "MNT",
    })
    await applyPaymentEventWithDb(input.db, {
      id: eventID,
      provider: input.provider,
      merchantAccountID,
      externalEventID: `event_${input.suffix}_paid`,
      externalInvoiceID,
      externalPaymentID,
      amount: input.amount,
      currency: "MNT",
      type: "paid",
      payloadHash: hash("a"),
      occurredAt: effectiveAt,
    })
    return {
      invoiceID,
      eventID,
      merchantAccountID,
      externalInvoiceID,
      externalPaymentID,
    }
  }

  test("records exact QPay fees and taxes once and rejects a conflicting replay", async () => {
    const { sqlite, db } = await fixture()
    const payment = await paidInvoice({ db, provider: "qpay", suffix: "qpay", amount: 100_000 })
    const settlement = {
      id: "fps_qpay_payment",
      workspaceID: "wrk_settlement",
      paymentInvoiceID: payment.invoiceID,
      paymentEventID: payment.eventID,
      provider: "qpay" as const,
      merchantAccountID: payment.merchantAccountID,
      externalSettlementID: "qpay_statement_line_1",
      kind: "payment" as const,
      grossAmountMNT: 100_000,
      feeAmountMNT: 1_000,
      taxAmountMNT: 100,
      netAmountMNT: 98_900,
      currency: "MNT" as const,
      idempotencyKey: "qpay:statement:line:1",
      payloadHash: hash("b"),
      effectiveAt,
    }

    await expect(recordFinancePaymentSettlementWithDb(db, settlement)).resolves.toMatchObject({
      kind: "created",
    })
    await expect(recordFinancePaymentSettlementWithDb(db, settlement)).resolves.toMatchObject({
      kind: "duplicate",
    })
    await expect(
      recordFinancePaymentSettlementWithDb(db, {
        ...settlement,
        feeAmountMNT: 1_100,
        netAmountMNT: 98_800,
      }),
    ).rejects.toThrow("Санхүүгийн төлбөрийн тооцоог дахин тоглуулахад хадгалсан тооцоотой зөрчилдлөө")

    expect(
      sqlite
        .query(
          "select kind, gross_amount_mnt, fee_amount_mnt, tax_amount_mnt, net_amount_mnt from finance_payment_settlement",
        )
        .get(),
    ).toEqual({
      kind: "payment",
      gross_amount_mnt: 100_000,
      fee_amount_mnt: 1_000,
      tax_amount_mnt: 100,
      net_amount_mnt: 98_900,
    })
    expect(
      sqlite
        .query(
          "select category, direction, basis, original_amount, original_currency, amount_mnt_micros from finance_cost_entry order by category",
        )
        .all(),
    ).toEqual([
      {
        category: "payment_fee",
        direction: "debit",
        basis: "actual",
        original_amount: 1_000,
        original_currency: "MNT",
        amount_mnt_micros: 1_000_000_000,
      },
      {
        category: "tax",
        direction: "debit",
        basis: "actual",
        original_amount: 100,
        original_currency: "MNT",
        amount_mnt_micros: 100_000_000,
      },
    ])
  })

  test("preserves an explicit zero-fee settlement without inventing a cost", async () => {
    const { sqlite, db } = await fixture()
    const payment = await paidInvoice({ db, provider: "bonum", suffix: "zero_fee", amount: 50_000 })

    await expect(
      recordFinancePaymentSettlementWithDb(db, {
        id: "fps_zero_fee",
        workspaceID: "wrk_settlement",
        paymentInvoiceID: payment.invoiceID,
        paymentEventID: payment.eventID,
        provider: "bonum",
        merchantAccountID: payment.merchantAccountID,
        externalSettlementID: "bonum_statement_zero_fee",
        kind: "payment",
        grossAmountMNT: 50_000,
        feeAmountMNT: 0,
        taxAmountMNT: 0,
        netAmountMNT: 50_000,
        currency: "MNT",
        idempotencyKey: "bonum:statement:zero-fee",
        payloadHash: hash("c"),
        effectiveAt,
      }),
    ).resolves.toMatchObject({ kind: "created", costs: [] })

    expect(sqlite.query("select count(*) as count from finance_payment_settlement").get()).toEqual({ count: 1 })
    expect(sqlite.query("select count(*) as count from finance_cost_entry").get()).toEqual({ count: 0 })
  })

  test("records a returned fee as an actual credit on a verified refund", async () => {
    const { sqlite, db } = await fixture()
    const payment = await paidInvoice({ db, provider: "qpay", suffix: "refund", amount: 100_000 })
    await applyPaymentEventWithDb(db, {
      id: "pev_refund_refunded",
      provider: "qpay",
      merchantAccountID: payment.merchantAccountID,
      externalEventID: "event_refund_refunded",
      externalInvoiceID: payment.externalInvoiceID,
      externalPaymentID: payment.externalPaymentID,
      amount: 100_000,
      currency: "MNT",
      type: "refunded",
      payloadHash: hash("d"),
      occurredAt: effectiveAt + 1_000,
    })

    await recordFinancePaymentSettlementWithDb(db, {
      id: "fps_qpay_refund",
      workspaceID: "wrk_settlement",
      paymentInvoiceID: payment.invoiceID,
      paymentEventID: "pev_refund_refunded",
      provider: "qpay",
      merchantAccountID: payment.merchantAccountID,
      externalSettlementID: "qpay_refund_line_1",
      kind: "refund",
      grossAmountMNT: -100_000,
      feeAmountMNT: -100,
      taxAmountMNT: 0,
      netAmountMNT: -99_900,
      currency: "MNT",
      idempotencyKey: "qpay:refund:line:1",
      payloadHash: hash("e"),
      effectiveAt: effectiveAt + 1_000,
    })

    expect(
      sqlite.query("select category, direction, original_amount, amount_mnt_micros from finance_cost_entry").get(),
    ).toEqual({
      category: "payment_fee",
      direction: "credit",
      original_amount: 100,
      amount_mnt_micros: 100_000_000,
    })
  })

  test("validates invoice identity, balance, event type, and database immutability", async () => {
    const { sqlite, db } = await fixture()
    const payment = await paidInvoice({ db, provider: "qpay", suffix: "guard", amount: 75_000 })
    const settlement = {
      id: "fps_guard",
      workspaceID: "wrk_settlement",
      paymentInvoiceID: payment.invoiceID,
      paymentEventID: payment.eventID,
      provider: "qpay" as const,
      merchantAccountID: payment.merchantAccountID,
      externalSettlementID: "qpay_guard_line",
      kind: "payment" as const,
      grossAmountMNT: 75_000,
      feeAmountMNT: 750,
      taxAmountMNT: 0,
      netAmountMNT: 74_250,
      currency: "MNT" as const,
      idempotencyKey: "qpay:guard:line",
      payloadHash: hash("f"),
      effectiveAt,
    }

    await expect(recordFinancePaymentSettlementWithDb(db, { ...settlement, netAmountMNT: 1 })).rejects.toThrow(
      "Тооцооны дүнгүүд тэнцэхгүй байна",
    )
    await expect(
      recordFinancePaymentSettlementWithDb(db, { ...settlement, merchantAccountID: "wrong_merchant" }),
    ).rejects.toThrow("Санхүүгийн төлбөрийн тооцоо нэхэмжлэлтэй таарахгүй байна")
    await recordFinancePaymentSettlementWithDb(db, settlement)

    expect(() =>
      sqlite.query("update finance_payment_settlement set fee_amount_mnt = ? where id = ?").run(1, settlement.id),
    ).toThrow("finance_payment_settlement is immutable")
    expect(() => sqlite.query("delete from finance_payment_settlement where id = ?").run(settlement.id)).toThrow(
      "finance_payment_settlement is immutable",
    )
  })
})
