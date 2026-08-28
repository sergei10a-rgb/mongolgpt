import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { createPlanSubscriptionPaymentEffect } from "../src/payment-entitlement"
import { applyPaymentEventWithDb } from "../src/payment-ledger"
import {
  PaymentRefundConflictError,
  PaymentRefundOperationError,
  PaymentRefundUnsupportedError,
  refundPlatformAdminSubscriptionPayment,
} from "../src/payment-refund"
import { createSubscriptionCheckout, type PaymentPlanCatalog } from "../src/payment-checkout"
import {
  PaymentProviderResponseError,
  type PaymentRefundAdapter,
  type PaymentRefundReceipt,
} from "../src/payment-provider"
import { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

const NOW = Date.UTC(2026, 7, 28, 6)
const CHECKOUT_REQUEST = "11111111-1111-4111-8111-111111111111"
const REFUND_REQUEST = "22222222-2222-4222-8222-222222222222"
const REPLAY_REQUEST = "33333333-3333-4333-8333-333333333333"
const catalog: PaymentPlanCatalog = {
  basic: { label: "Basic", amount: 19_000 },
  pro: { label: "Pro", amount: 49_000 },
  max: { label: "Max", amount: 99_000 },
}

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

describe("platform admin subscription payment refund", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the test adapter implements the D1 subset used here
    const db = drizzleDb as unknown as Database.TxOrDb
    const workspaceID = "wrk_refund_test"
    const accountID = "acc_refund_test"
    sqlite.query("insert into account (id) values (?)").run(accountID)
    sqlite.query("insert into workspace (id, name) values (?, ?)").run(workspaceID, "Refund test")
    sqlite
      .query("insert into user (id, workspace_id, account_id, name, role) values (?, ?, ?, ?, ?)")
      .run("usr_refund_test", workspaceID, accountID, "", "admin")
    sqlite
      .query("insert into billing (id, workspace_id, balance) values (?, ?, ?)")
      .run("bil_refund_test", workspaceID, 0)

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

    async function paidCheckout(
      provider: "qpay" | "bonum",
      refundPayment: PaymentRefundAdapter["refundPayment"],
      reconcileRefund: PaymentRefundAdapter["reconcileRefund"] = async () => undefined,
    ) {
      const merchantAccountID = `${provider}_merchant_refund_test`
      const externalInvoiceID = `${provider}_external_refund_test`
      const externalPaymentID = `${provider}_payment_refund_test`
      const adapter: PaymentRefundAdapter = {
        provider,
        merchantAccountID,
        async createInvoice() {
          return { provider, merchantAccountID, externalInvoiceID, deepLinks: [] }
        },
        refundPayment,
        reconcileRefund,
      }
      const checkout = await createSubscriptionCheckout(
        { workspaceID, accountID, requestKey: CHECKOUT_REQUEST, provider, plan: "pro" },
        { adapter, catalog, transaction, now: () => NOW },
      )
      await transaction((tx) =>
        applyPaymentEventWithDb(
          tx,
          {
            provider,
            merchantAccountID,
            externalEventID: `${provider}_paid_refund_test`,
            externalInvoiceID,
            externalPaymentID,
            amount: 49_000,
            currency: "MNT",
            type: "paid",
            payloadHash: "a".repeat(64),
            occurredAt: NOW - 1_000,
          },
          createPlanSubscriptionPaymentEffect({ now: () => NOW }),
        ),
      )
      return { adapter, checkout, merchantAccountID, externalInvoiceID, externalPaymentID }
    }

    return { sqlite, db, workspaceID, accountID, transaction, paidCheckout }
  }

  const request = (invoiceID: string, requestKey = REFUND_REQUEST) => ({
    invoiceID,
    requestKey,
    reason: "Хэрэглэгчийн баталгаажсан хүсэлтээр төлбөрийг бүтнээр буцааж байна.",
  })

  test("reserves before one provider mutation, replays safely, and revokes entitlement only after the event", async () => {
    const environment = await fixture()
    let providerCalls = 0
    let created: Awaited<ReturnType<typeof environment.paidCheckout>>
    created = await environment.paidCheckout("qpay", async (input): Promise<PaymentRefundReceipt> => {
      providerCalls++
      expect(input).toEqual({
        externalInvoiceID: "qpay_external_refund_test",
        externalPaymentID: "qpay_payment_refund_test",
        amount: 49_000,
        currency: "MNT",
      })
      expect(
        environment.sqlite
          .query("select status from payment_refund where invoice_id = ?")
          .get(created.checkout.invoiceID),
      ).toEqual({ status: "requested" })
      return {
        provider: "qpay",
        merchantAccountID: created.merchantAccountID,
        ...input,
        providerPayloadHash: "b".repeat(64),
      }
    })
    const dependencies = {
      adapters: { qpay: created.adapter },
      transaction: environment.transaction,
      now: () => NOW,
    }

    const first = await refundPlatformAdminSubscriptionPayment(request(created.checkout.invoiceID), dependencies)
    const replay = await refundPlatformAdminSubscriptionPayment(
      request(created.checkout.invoiceID, REPLAY_REQUEST),
      dependencies,
    )

    expect(providerCalls).toBe(1)
    expect(first.result).toEqual({ invoiceID: created.checkout.invoiceID, provider: "qpay", status: "refunded" })
    expect(first.event).toEqual(replay.event)
    expect(first.event).toMatchObject({
      provider: "qpay",
      merchantAccountID: created.merchantAccountID,
      externalInvoiceID: created.externalInvoiceID,
      externalPaymentID: created.externalPaymentID,
      amount: 49_000,
      currency: "MNT",
      type: "refunded",
      payloadHash: "b".repeat(64),
      occurredAt: NOW,
    })
    expect(first.event?.externalEventID).toHaveLength(64)
    expect(environment.sqlite.query("select status from payment_invoice").get()).toEqual({ status: "paid" })
    expect(environment.sqlite.query("select status from plan_subscription").get()).toEqual({ status: "active" })

    await environment.transaction((tx) =>
      applyPaymentEventWithDb(tx, first.event!, createPlanSubscriptionPaymentEffect({ now: () => NOW })),
    )
    expect(environment.sqlite.query("select status from payment_invoice").get()).toEqual({ status: "refunded" })
    expect(environment.sqlite.query("select status from payment_checkout").get()).toEqual({ status: "refunded" })
    expect(environment.sqlite.query("select status from plan_subscription").get()).toEqual({ status: "refunded" })
    expect(environment.sqlite.query("select subscription from billing").get()).toEqual({ subscription: null })
    expect(
      environment.sqlite
        .query("select status, error_code, provider_payload_hash, time_requested, time_completed from payment_refund")
        .get(),
    ).toEqual({
      status: "refunded",
      error_code: null,
      provider_payload_hash: "b".repeat(64),
      time_requested: NOW,
      time_completed: NOW,
    })
  })

  test("fails closed for Bonum web payments before any provider mutation", async () => {
    const environment = await fixture()
    let providerCalls = 0
    const created = await environment.paidCheckout("bonum", async () => {
      providerCalls++
      throw new Error("must not be called")
    })

    const error = await refundPlatformAdminSubscriptionPayment(request(created.checkout.invoiceID), {
      adapters: { bonum: created.adapter },
      transaction: environment.transaction,
      now: () => NOW,
    }).catch((cause) => cause)

    expect(error).toBeInstanceOf(PaymentRefundUnsupportedError)
    expect(providerCalls).toBe(0)
    expect(environment.sqlite.query("select count(*) as count from payment_refund").get()).toEqual({ count: 0 })
  })

  test("persists deterministic failed and unknown states instead of retrying money movement", async () => {
    for (const status of [422, 503]) {
      const environment = await fixture()
      let providerCalls = 0
      const created = await environment.paidCheckout("qpay", async () => {
        providerCalls++
        throw new PaymentProviderResponseError({ provider: "qpay", operation: "refund payment", status })
      })
      const dependencies = {
        adapters: { qpay: created.adapter },
        transaction: environment.transaction,
        now: () => NOW,
      }

      const error = await refundPlatformAdminSubscriptionPayment(
        request(created.checkout.invoiceID),
        dependencies,
      ).catch((cause) => cause)
      const replay = await refundPlatformAdminSubscriptionPayment(
        request(created.checkout.invoiceID, REPLAY_REQUEST),
        dependencies,
      ).catch((cause) => cause)

      expect(error).toBeInstanceOf(PaymentRefundOperationError)
      expect(error).toMatchObject({ state: status === 422 ? "failed" : "unknown", code: `provider_${status}` })
      expect(replay).toBeInstanceOf(PaymentRefundConflictError)
      expect(replay).toMatchObject({ state: status === 422 ? "request_failed" : "result_unknown" })
      expect(providerCalls).toBe(1)
      expect(environment.sqlite.query("select status, error_code from payment_refund").get()).toEqual({
        status: status === 422 ? "failed" : "unknown",
        error_code: `provider_${status}`,
      })
      expect(environment.sqlite.query("select status from payment_invoice").get()).toEqual({ status: "paid" })
    }
  })

  test("recovers a provider-confirmed refund after local persistence fails without a second money mutation", async () => {
    const environment = await fixture()
    let providerCalls = 0
    let reconciliationCalls = 0
    let created: Awaited<ReturnType<typeof environment.paidCheckout>>
    const receipt = () => ({
      provider: "qpay" as const,
      merchantAccountID: created.merchantAccountID,
      externalInvoiceID: created.externalInvoiceID,
      externalPaymentID: created.externalPaymentID,
      amount: 49_000,
      currency: "MNT" as const,
      providerPayloadHash: "c".repeat(64),
    })
    created = await environment.paidCheckout(
      "qpay",
      async () => {
        providerCalls++
        return receipt()
      },
      async () => {
        reconciliationCalls++
        return receipt()
      },
    )
    let transactionCalls = 0
    const flakyTransaction: typeof environment.transaction = async (callback) => {
      transactionCalls++
      if (transactionCalls === 2 || transactionCalls === 3) throw new Error("simulated D1 write outage")
      return environment.transaction(callback)
    }

    const first = await refundPlatformAdminSubscriptionPayment(request(created.checkout.invoiceID), {
      adapters: { qpay: created.adapter },
      transaction: flakyTransaction,
      now: () => NOW,
    }).catch((cause) => cause)
    expect(first).toBeInstanceOf(PaymentRefundOperationError)
    expect(first).toMatchObject({ state: "unknown", code: "persistence_failed" })
    expect(environment.sqlite.query("select status, error_code from payment_refund").get()).toEqual({
      status: "unknown",
      error_code: "persistence_failed",
    })

    const recovered = await refundPlatformAdminSubscriptionPayment(
      request(created.checkout.invoiceID, REPLAY_REQUEST),
      {
        adapters: { qpay: created.adapter },
        transaction: environment.transaction,
        now: () => NOW + 1_000,
      },
    )
    expect(providerCalls).toBe(1)
    expect(reconciliationCalls).toBe(1)
    expect(recovered.result.status).toBe("refunded")
    expect(recovered.event).toMatchObject({ type: "refunded", payloadHash: "c".repeat(64) })
    expect(environment.sqlite.query("select status, error_code from payment_refund").get()).toEqual({
      status: "refunded",
      error_code: null,
    })
  })
})
