/// <reference path="../../admin/src/global.d.ts" />

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { createPaymentWebhookHandler } from "../../function/src/payment-webhook"
import { createPaymentQueueConsumer } from "../../function/src/payment-queue"
import { getAdminBilling } from "../../admin/src/lib/admin-billing"
import { Database } from "../src/drizzle"
import { createSubscriptionCheckout, type PaymentPlanCatalog } from "../src/payment-checkout"
import { createPlanSubscriptionPaymentEffect } from "../src/payment-entitlement"
import { type PaymentProviderAdapter } from "../src/payment-provider"
import {
  recordFinanceCostEntryWithDb,
  recordFinanceCostValuationWithDb,
  recordFinanceFxRateWithDb,
} from "../src/finance-ledger"
import { recordFinancePaymentSettlementWithDb } from "../src/finance-settlement"
import { applyPaymentQueueEventWithDb, type PaymentQueueEvent } from "../src/payment-queue"
import { PlatformAdminPermissions } from "../src/platform-admin"
import * as schema from "../src/schema-d1"

const NOW = Date.UTC(2026, 7, 1, 9, 30)
const PAID_AT = NOW + 60_000
const EFFECTIVE_AT = NOW + 120_000
const REPORT_NOW = new Date("2026-08-30T12:00:00.000Z")

const catalog: PaymentPlanCatalog = {
  basic: { label: "Basic", amount: 19_000 },
  pro: { label: "Pro", amount: 39_000 },
  max: { label: "Max", amount: 99_000 },
}

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

function hash(character: string) {
  return character.repeat(64)
}

function queueMessage(body: unknown) {
  let acknowledged = 0
  let retried = 0
  return {
    body,
    ack() {
      acknowledged++
    },
    retry() {
      retried++
    },
    result() {
      return { acknowledged, retried }
    },
  }
}

describe("payment E2E contract", () => {
  const restoreSpies: Array<() => void> = []

  afterEach(() => {
    while (restoreSpies.length > 0) restoreSpies.pop()?.()
  })

  test("stitches checkout through webhook, queue, entitlement, and admin billing margin in one contract", async () => {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    const db = drizzleDb as unknown as Database.TxOrDb

    const workspaceID = "wrk_pay_e2e_contract"
    const accountID = "acc_pay_e2e_contract"
    const merchantAccountID = "merchant_pay_e2e_contract"
    const externalInvoiceID = "qpay_invoice_pay_e2e_contract"
    const externalPaymentID = "qpay_payment_pay_e2e_contract"

    sqlite.query("insert into account (id) values (?)").run(accountID)
    sqlite.query("insert into workspace (id, name) values (?, ?)").run(workspaceID, "Payment E2E")
    sqlite
      .query("insert into user (id, workspace_id, account_id, email, name, role) values (?, ?, ?, ?, ?, ?)")
      .run("usr_pay_e2e_admin", workspaceID, accountID, "billing@mgpt.mn", "Billing admin", "admin")
    sqlite
      .query("insert into billing (id, workspace_id, balance) values (?, ?, ?)")
      .run("bil_pay_e2e_contract", workspaceID, 0)
    sqlite
      .query(
        `insert into usage
          (id, workspace_id, user_id, time_created, provider, model, input_tokens, output_tokens, cost, enrichment)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "usg_pay_e2e_contract",
        workspaceID,
        "usr_pay_e2e_admin",
        EFFECTIVE_AT,
        "openrouter",
        "anthropic/claude-sonnet",
        1_500,
        900,
        100_000_000,
        JSON.stringify({ plan: "pro" }),
      )

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

    const adapter: PaymentProviderAdapter = {
      provider: "qpay",
      merchantAccountID,
      async createInvoice(input) {
        expect(input.reference).toMatch(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/)
        expect(input.amount).toBe(39_000)
        return {
          provider: "qpay",
          merchantAccountID,
          externalInvoiceID,
          qrText: "qpay://pay-e2e-contract",
          deepLinks: [{ name: "QPay", description: "Sandbox", link: "qpaywallet://sandbox/pay-e2e-contract" }],
        }
      },
    }

    const checkout = await createSubscriptionCheckout(
      {
        workspaceID,
        accountID,
        requestKey: "4cf1fec6-0f45-4ca0-9540-18f0ae954642",
        provider: "qpay",
        plan: "pro",
      },
      {
        adapter,
        catalog,
        transaction,
        now: () => NOW,
      },
    )

    const queued: PaymentQueueEvent[] = []
    const webhook = createPaymentWebhookHandler({
      async qpay(input) {
        expect(input).toEqual({ reference: checkout.invoiceID, callbackPaymentID: externalPaymentID })
        return [
          {
            provider: "qpay",
            merchantAccountID,
            externalEventID: "qpay_event_pay_e2e_contract",
            externalInvoiceID,
            externalPaymentID,
            amount: 39_000,
            currency: "MNT",
            type: "paid",
            payloadHash: hash("a"),
            occurredAt: PAID_AT,
          },
        ]
      },
      async enqueue(events) {
        queued.push(...events)
      },
    })

    const webhookResponse = await webhook(
      new Request(`https://pay.dev.mgpt.mn/v1/webhooks/qpay?invoice=${checkout.invoiceID}&payment_id=${externalPaymentID}`),
    )

    expect(webhookResponse.status).toBe(200)
    expect(await webhookResponse.text()).toBe("SUCCESS")
    expect(queued).toHaveLength(1)

    const message = queueMessage(queued[0])
    const queue = createPaymentQueueConsumer(async (event) =>
      transaction((tx) => applyPaymentChain(sqlite, tx, event, EFFECTIVE_AT)),
    )
    await queue.queue({ messages: [message] })
    expect(message.result()).toEqual({ acknowledged: 1, retried: 0 })

    const useSpy = spyOn(Database, "use").mockImplementation(async (callback) => callback(db))
    restoreSpies.push(() => useSpy.mockRestore())

    const billing = await getAdminBilling(
      {
        id: "adm_pay_e2e_owner",
        email: "owner@mgpt.mn",
        subject: "access-owner",
        role: "owner",
        permissions: [...PlatformAdminPermissions],
        requestID: "req_pay_e2e_contract",
        bootstrapped: false,
      },
      { period: "30d", provider: "all", status: "all" },
      REPORT_NOW,
    )

    expect(checkout).toMatchObject({
      invoiceID: checkout.invoiceID,
      status: "ready",
      provider: "qpay",
      plan: "pro",
      amount: 39_000,
    })
    expect(sqlite.query("select status, external_payment_id from payment_invoice where id = ?").get(checkout.invoiceID)).toEqual({
      status: "paid",
      external_payment_id: externalPaymentID,
    })
    expect(sqlite.query("select status, plan from plan_subscription where invoice_id = ?").get(checkout.invoiceID)).toEqual({
      status: "active",
      plan: "pro",
    })
    expect(billing.metrics).toMatchObject({
      grossRevenueMNT: 39_000,
      refundsMNT: 0,
      netRevenueMNT: 39_000,
      paidInvoices: 1,
      activeSubscriptions: 1,
      estimatedModelCostMicroCents: 100_000_000,
      actualModelCostMNTMicros: 3_450_000_000,
      paymentCostMNTMicros: 1_100_000_000,
      recognizedRevenueMNTMicros: 39_000_000_000,
    })
    expect(billing.finance.margin).toEqual({
      available: true,
      recognizedRevenueMNTMicros: 39_000_000_000,
      valueMNTMicros: 34_450_000_000,
      reasons: [],
    })
    expect(billing.invoices).toHaveLength(1)
    expect(billing.invoices[0]).toMatchObject({
      id: checkout.invoiceID,
      workspaceID,
      workspaceName: "Payment E2E",
      provider: "qpay",
      plan: "pro",
      amount: 39_000,
      status: "paid",
      canCancel: false,
      canRefund: true,
      refundNeedsSync: false,
      refundNeedsProviderCheck: false,
    })
  })
})

async function applyPaymentChain(sqlite: SQLite, db: Database.TxOrDb, event: PaymentQueueEvent, effectiveAt: number) {
  const result = await applyPaymentQueueEventWithDb(
    db,
    event,
    createPlanSubscriptionPaymentEffect({
      now: () => effectiveAt,
    }),
  )

  if (result.kind !== "applied") return result

  await recordFinanceFxRateWithDb(db, {
    id: "fxr_pay_e2e_contract",
    rateMicromntPerUSD: 3_450_000_000,
    source: "mongolbank",
    sourceReference: "2026-08-01:USD",
    idempotencyKey: "fx:mongolbank:2026-08-01:USD",
    payloadHash: hash("b"),
    effectiveAt,
  })
  await recordFinanceCostEntryWithDb(db, {
    id: "fce_pay_e2e_contract",
    workspaceID: result.invoice.workspace_id,
    category: "model_cost",
    direction: "debit",
    basis: "actual",
    sourceType: "provider_statement",
    sourceReference: "openrouter:e2e:line:1",
    usageID: "usg_pay_e2e_contract",
    provider: "openrouter",
    model: "anthropic/claude-sonnet",
    originalAmount: 100_000_000,
    originalCurrency: "USD",
    idempotencyKey: "openrouter:e2e:line:1:model-cost",
    payloadHash: hash("c"),
    effectiveAt,
  })
  await recordFinanceCostValuationWithDb(db, {
    id: "fvl_pay_e2e_contract",
    costEntryID: "fce_pay_e2e_contract",
    fxRateID: "fxr_pay_e2e_contract",
    method: "historical_spot",
    version: 1,
    idempotencyKey: "valuation:openrouter:e2e:line:1:v1",
    payloadHash: hash("d"),
  })
  await recordFinancePaymentSettlementWithDb(db, {
    id: "fps_pay_e2e_contract",
    workspaceID: result.invoice.workspace_id,
    paymentInvoiceID: result.invoice.id,
    paymentEventID:
      (sqlite.query("select id from payment_event where invoice_id = ? order by time_created desc limit 1").get(
        result.invoice.id,
      ) as { id?: string } | null)?.id ?? undefined,
    provider: "qpay",
    merchantAccountID: result.invoice.merchant_account_id,
    externalSettlementID: "qpay:settlement:pay-e2e-contract",
    kind: "payment",
    grossAmountMNT: 39_000,
    feeAmountMNT: 1_000,
    taxAmountMNT: 100,
    netAmountMNT: 37_900,
    currency: "MNT",
    idempotencyKey: "qpay:settlement:pay-e2e-contract",
    payloadHash: hash("e"),
    effectiveAt,
  })

  return result
}
