import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import type { Database } from "../src/drizzle"
import { calculateFinanceGrossMargin, getFinanceMarginEvidenceWithDb } from "../src/finance-reporting"
import {
  recordFinanceCostEntryWithDb,
  recordFinanceCostValuationWithDb,
  recordFinanceFxRateWithDb,
} from "../src/finance-ledger"
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
const reportStart = new Date("2026-07-01T00:00:00.000Z")
const reportEnd = new Date("2026-08-01T00:00:00.000Z")
const effectiveAt = Date.parse("2026-07-30T01:00:00.000Z")

describe("finance margin reporting", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Test drivers share this schema contract.
    const db = drizzleDb as unknown as Database.TxOrDb
    sqlite.query("insert into workspace (id, name) values (?, ?)").run("wrk_report", "Report test")
    return { sqlite, db }
  }

  function insertUsage(
    sqlite: SQLite,
    input: {
      id: string
      cost: number
      plan: "pro" | "byok"
      provider?: string
      model?: string
      timeCreated?: number
      userID?: string
    },
  ) {
    sqlite
      .query(
        `insert into usage
          (id, workspace_id, time_created, model, provider, input_tokens, output_tokens, cost, enrichment, user_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        "wrk_report",
        input.timeCreated ?? effectiveAt,
        input.model ?? "anthropic/claude-sonnet",
        input.provider ?? "openrouter",
        1_000,
        500,
        input.cost,
        JSON.stringify({ plan: input.plan }),
        input.userID ?? null,
      )
  }

  async function paidInvoice(db: Database.TxOrDb, occurredAt = effectiveAt) {
    await recordPaymentInvoiceWithDb(db, {
      id: "inv_report",
      workspaceID: "wrk_report",
      provider: "qpay",
      merchantAccountID: "merchant_report",
      externalInvoiceID: "external_invoice_report",
      purpose: "credit",
      amount: 100_000,
      currency: "MNT",
    })
    await applyPaymentEventWithDb(db, {
      id: "pev_report_paid",
      provider: "qpay",
      merchantAccountID: "merchant_report",
      externalEventID: "event_report_paid",
      externalInvoiceID: "external_invoice_report",
      externalPaymentID: "external_payment_report",
      amount: 100_000,
      currency: "MNT",
      type: "paid",
      payloadHash: hash("a"),
      occurredAt,
    })
  }

  test("refuses a margin while managed usage or payment evidence is incomplete", async () => {
    const { sqlite, db } = await fixture()
    insertUsage(sqlite, { id: "usg_report_one", cost: 100_000_000, plan: "pro" })
    insertUsage(sqlite, { id: "usg_report_two", cost: 50_000_000, plan: "pro" })
    insertUsage(sqlite, { id: "usg_report_free", cost: 0, plan: "pro" })
    insertUsage(sqlite, { id: "usg_report_byok", cost: 500_000_000, plan: "byok" })
    await paidInvoice(db)
    await recordFinanceCostEntryWithDb(db, {
      id: "fce_report_unvalued",
      workspaceID: "wrk_report",
      category: "model_cost",
      direction: "debit",
      basis: "actual",
      sourceType: "provider_statement",
      sourceReference: "openrouter:report:line:1",
      usageID: "usg_report_one",
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
      originalAmount: 100_000_000,
      originalCurrency: "USD",
      idempotencyKey: "openrouter:report:line:1:model-cost",
      payloadHash: hash("b"),
      effectiveAt,
    })

    const evidence = await getFinanceMarginEvidenceWithDb(db, {
      start: reportStart,
      end: reportEnd,
    })

    expect(evidence).toEqual({
      model: {
        expectedUsage: 2,
        coveredUsage: 0,
        missingUsage: 2,
        valuedEntries: 0,
        unvaluedEntries: 1,
        debitMNTMicros: 0,
        creditMNTMicros: 0,
        costMNTMicros: 0,
        complete: false,
      },
      payments: {
        expectedEvents: 1,
        coveredEvents: 0,
        missingEvents: 1,
        ambiguousEvents: 0,
        feeMNTMicros: null,
        taxMNTMicros: null,
        revenueAdjustmentMNTMicros: null,
        costMNTMicros: null,
        complete: false,
      },
    })
    expect(
      calculateFinanceGrossMargin({
        netRevenueMNT: 100_000,
        paymentProvider: "all",
        evidence,
      }),
    ).toEqual({
      available: false,
      recognizedRevenueMNTMicros: null,
      valueMNTMicros: null,
      reasons: ["missing_model_costs", "unvalued_model_costs", "missing_payment_settlements"],
    })
  })

  test("uses latest MNT valuations and accrues settlement costs to the invoice event", async () => {
    const { sqlite, db } = await fixture()
    insertUsage(sqlite, { id: "usg_report_one", cost: 100_000_000, plan: "pro" })
    insertUsage(sqlite, { id: "usg_report_two", cost: 50_000_000, plan: "pro" })
    await paidInvoice(db)

    await recordFinanceFxRateWithDb(db, {
      id: "fxr_report",
      rateMicromntPerUSD: 3_450_000_000,
      source: "mongolbank",
      sourceReference: "2026-07-30:USD",
      idempotencyKey: "fx:mongolbank:2026-07-30:USD",
      payloadHash: hash("c"),
      effectiveAt,
    })
    await recordFinanceCostEntryWithDb(db, {
      id: "fce_report_one",
      workspaceID: "wrk_report",
      category: "model_cost",
      direction: "debit",
      basis: "actual",
      sourceType: "provider_statement",
      sourceReference: "openrouter:report:line:1",
      usageID: "usg_report_one",
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
      originalAmount: 100_000_000,
      originalCurrency: "USD",
      idempotencyKey: "openrouter:report:line:1:model-cost",
      payloadHash: hash("d"),
      effectiveAt,
    })
    await recordFinanceCostValuationWithDb(db, {
      id: "fvl_report_one",
      costEntryID: "fce_report_one",
      fxRateID: "fxr_report",
      method: "historical_spot",
      version: 1,
      idempotencyKey: "valuation:openrouter:report:line:1:v1",
      payloadHash: hash("e"),
    })
    await recordFinanceCostEntryWithDb(db, {
      id: "fce_report_two",
      workspaceID: "wrk_report",
      category: "model_cost",
      direction: "debit",
      basis: "actual",
      sourceType: "provider_statement",
      sourceReference: "openrouter:report:line:2",
      usageID: "usg_report_two",
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
      originalAmount: 1_725,
      originalCurrency: "MNT",
      idempotencyKey: "openrouter:report:line:2:model-cost",
      payloadHash: hash("f"),
      effectiveAt,
    })
    await recordFinancePaymentSettlementWithDb(db, {
      id: "fps_report_payment",
      workspaceID: "wrk_report",
      paymentInvoiceID: "inv_report",
      paymentEventID: "pev_report_paid",
      provider: "qpay",
      merchantAccountID: "merchant_report",
      externalSettlementID: "qpay_report_line_1",
      kind: "payment",
      grossAmountMNT: 100_000,
      feeAmountMNT: 1_000,
      taxAmountMNT: 100,
      netAmountMNT: 98_900,
      currency: "MNT",
      idempotencyKey: "qpay:report:line:1",
      payloadHash: hash("1"),
      effectiveAt: reportEnd.getTime() + 86_400_000,
    })

    const evidence = await getFinanceMarginEvidenceWithDb(db, {
      start: reportStart,
      end: reportEnd,
    })
    expect(evidence).toEqual({
      model: {
        expectedUsage: 2,
        coveredUsage: 2,
        missingUsage: 0,
        valuedEntries: 2,
        unvaluedEntries: 0,
        debitMNTMicros: 5_175_000_000,
        creditMNTMicros: 0,
        costMNTMicros: 5_175_000_000,
        complete: true,
      },
      payments: {
        expectedEvents: 1,
        coveredEvents: 1,
        missingEvents: 0,
        ambiguousEvents: 0,
        feeMNTMicros: 1_000_000_000,
        taxMNTMicros: 100_000_000,
        revenueAdjustmentMNTMicros: 0,
        costMNTMicros: 1_100_000_000,
        complete: true,
      },
    })
    expect(
      calculateFinanceGrossMargin({
        netRevenueMNT: 100_000,
        paymentProvider: "all",
        evidence,
      }),
    ).toEqual({
      available: true,
      recognizedRevenueMNTMicros: 100_000_000_000,
      valueMNTMicros: 93_725_000_000,
      reasons: [],
    })
    expect(
      calculateFinanceGrossMargin({
        netRevenueMNT: 100_000,
        paymentProvider: "qpay",
        evidence,
      }),
    ).toEqual({
      available: false,
      recognizedRevenueMNTMicros: 100_000_000_000,
      valueMNTMicros: null,
      reasons: ["payment_provider_filter"],
    })

    await recordFinancePaymentSettlementWithDb(db, {
      id: "fps_report_adjustment",
      workspaceID: "wrk_report",
      paymentInvoiceID: "inv_report",
      provider: "qpay",
      merchantAccountID: "merchant_report",
      externalSettlementID: "qpay_report_adjustment_1",
      kind: "adjustment",
      grossAmountMNT: 500,
      feeAmountMNT: 5,
      taxAmountMNT: 0,
      netAmountMNT: 495,
      currency: "MNT",
      idempotencyKey: "qpay:report:adjustment:1",
      payloadHash: hash("2"),
      effectiveAt,
    })
    const adjustedEvidence = await getFinanceMarginEvidenceWithDb(db, {
      start: reportStart,
      end: reportEnd,
    })
    expect(adjustedEvidence.payments).toMatchObject({
      feeMNTMicros: 1_005_000_000,
      taxMNTMicros: 100_000_000,
      revenueAdjustmentMNTMicros: 500_000_000,
      costMNTMicros: 1_105_000_000,
      complete: true,
    })
    expect(
      calculateFinanceGrossMargin({
        netRevenueMNT: 100_000,
        paymentProvider: "all",
        evidence: adjustedEvidence,
      }),
    ).toEqual({
      available: true,
      recognizedRevenueMNTMicros: 100_500_000_000,
      valueMNTMicros: 94_220_000_000,
      reasons: [],
    })
  })

  test("uses a half-open period and excludes events at the exact end instant", async () => {
    const { sqlite, db } = await fixture()
    insertUsage(sqlite, {
      id: "usg_report_start",
      cost: 1,
      plan: "pro",
      timeCreated: reportStart.getTime(),
    })
    insertUsage(sqlite, {
      id: "usg_report_end",
      cost: 1,
      plan: "pro",
      timeCreated: reportEnd.getTime(),
    })
    await paidInvoice(db, reportEnd.getTime())

    const evidence = await getFinanceMarginEvidenceWithDb(db, {
      start: reportStart,
      end: reportEnd,
    })
    expect(evidence.model).toMatchObject({
      expectedUsage: 1,
      coveredUsage: 0,
      missingUsage: 1,
    })
    expect(evidence.payments).toMatchObject({
      expectedEvents: 0,
      coveredEvents: 0,
      complete: true,
    })
  })

  test("scopes model and payment evidence to one account", async () => {
    const { sqlite, db } = await fixture()
    insertUsage(sqlite, { id: "usg_scope_owner", cost: 10, plan: "pro", userID: "usr_scope_owner" })
    insertUsage(sqlite, { id: "usg_scope_other", cost: 20, plan: "pro", userID: "usr_scope_other" })
    await paidInvoice(db)
    sqlite
      .query(
        `insert into payment_checkout
          (id, workspace_id, account_id, request_key, provider, merchant_account_id, external_invoice_id,
           purpose, amount, checkout, status, time_expires, time_paid)
         values (?, ?, ?, ?, ?, ?, ?, 'credit', ?, ?, 'paid', ?, ?)`,
      )
      .run(
        "pco_scope_owner",
        "wrk_report",
        "acc_scope_owner",
        "38103320-00de-47e1-8e2a-465d1427c951",
        "qpay",
        "merchant_report",
        "external_invoice_report",
        100_000,
        JSON.stringify({
          provider: "qpay",
          merchantAccountID: "merchant_report",
          externalInvoiceID: "external_invoice_report",
          deepLinks: [],
        }),
        reportEnd.getTime(),
        effectiveAt,
      )
    await recordFinancePaymentSettlementWithDb(db, {
      id: "fps_scope_owner",
      workspaceID: "wrk_report",
      paymentInvoiceID: "inv_report",
      paymentEventID: "pev_report_paid",
      provider: "qpay",
      merchantAccountID: "merchant_report",
      externalSettlementID: "qpay_scope_owner",
      kind: "payment",
      grossAmountMNT: 100_000,
      feeAmountMNT: 1_000,
      taxAmountMNT: 100,
      netAmountMNT: 98_900,
      currency: "MNT",
      idempotencyKey: "qpay:scope:owner",
      payloadHash: hash("5"),
      effectiveAt,
    })

    const owner = await getFinanceMarginEvidenceWithDb(db, {
      start: reportStart,
      end: reportEnd,
      userIDs: ["usr_scope_owner"],
      accountID: "acc_scope_owner",
    })
    expect(owner.model).toMatchObject({ expectedUsage: 1, missingUsage: 1 })
    expect(owner.payments).toMatchObject({ expectedEvents: 1, coveredEvents: 1, complete: true })

    const other = await getFinanceMarginEvidenceWithDb(db, {
      start: reportStart,
      end: reportEnd,
      userIDs: ["usr_scope_other"],
      accountID: "acc_scope_other",
    })
    expect(other.model).toMatchObject({ expectedUsage: 1, missingUsage: 1 })
    expect(other.payments).toMatchObject({ expectedEvents: 0, coveredEvents: 0, complete: true })
  })

  test("hides payment amounts and margin when settlement evidence is ambiguous", async () => {
    const { db } = await fixture()
    await paidInvoice(db)
    for (const [suffix, fee] of [
      ["one", 1_000],
      ["two", 2_000],
    ] as const) {
      await recordFinancePaymentSettlementWithDb(db, {
        id: `fps_duplicate_${suffix}`,
        workspaceID: "wrk_report",
        paymentInvoiceID: "inv_report",
        paymentEventID: "pev_report_paid",
        provider: "qpay",
        merchantAccountID: "merchant_report",
        externalSettlementID: `qpay_duplicate_${suffix}`,
        kind: "payment",
        grossAmountMNT: 100_000,
        feeAmountMNT: fee,
        taxAmountMNT: 0,
        netAmountMNT: 100_000 - fee,
        currency: "MNT",
        idempotencyKey: `qpay:duplicate:${suffix}`,
        payloadHash: hash(suffix === "one" ? "3" : "4"),
        effectiveAt,
      })
    }

    const evidence = await getFinanceMarginEvidenceWithDb(db, {
      start: reportStart,
      end: reportEnd,
    })
    expect(evidence.payments).toEqual({
      expectedEvents: 1,
      coveredEvents: 0,
      missingEvents: 0,
      ambiguousEvents: 1,
      feeMNTMicros: null,
      taxMNTMicros: null,
      revenueAdjustmentMNTMicros: null,
      costMNTMicros: null,
      complete: false,
    })
    expect(
      calculateFinanceGrossMargin({
        netRevenueMNT: 100_000,
        paymentProvider: "all",
        evidence,
      }),
    ).toEqual({
      available: false,
      recognizedRevenueMNTMicros: null,
      valueMNTMicros: null,
      reasons: ["ambiguous_payment_settlements"],
    })
  })

  test("rejects finance arithmetic outside the safe integer range", () => {
    expect(() =>
      calculateFinanceGrossMargin({
        netRevenueMNT: Number.MAX_SAFE_INTEGER,
        paymentProvider: "all",
        evidence: {
          model: {
            expectedUsage: 0,
            coveredUsage: 0,
            missingUsage: 0,
            valuedEntries: 0,
            unvaluedEntries: 0,
            debitMNTMicros: 0,
            creditMNTMicros: 0,
            costMNTMicros: 0,
            complete: true,
          },
          payments: {
            expectedEvents: 0,
            coveredEvents: 0,
            missingEvents: 0,
            ambiguousEvents: 0,
            feeMNTMicros: 0,
            taxMNTMicros: 0,
            revenueAdjustmentMNTMicros: 0,
            costMNTMicros: 0,
            complete: true,
          },
        },
      }),
    ).toThrow("аюулгүй бүхэл тооны хязгаараас хэтэрлээ")
  })

  test("rejects an inverted report period", async () => {
    const { db } = await fixture()
    await expect(
      getFinanceMarginEvidenceWithDb(db, {
        start: reportEnd,
        end: reportStart,
      }),
    ).rejects.toThrow("Санхүүгийн тайлангийн эхлэх хугацаа дуусах хугацаанаас хойш байж болохгүй")
  })
})
