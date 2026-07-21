import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import {
  cancelSubscriptionCheckout,
  PaymentCancellationAuthorizationError,
  PaymentCancellationConflictError,
  PaymentCancellationOperationError,
  PaymentCancellationUnsupportedError,
} from "../src/payment-cancellation"
import {
  createSubscriptionCheckout,
  getSubscriptionBillingOverviewWithDb,
  type PaymentPlanCatalog,
} from "../src/payment-checkout"
import {
  PaymentProviderResponseError,
  type PaymentCancellationAdapter,
  type PaymentInvoiceCancellationReceipt,
} from "../src/payment-provider"
import { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

const NOW = Date.UTC(2026, 6, 21, 15)
const CHECKOUT_REQUEST = "6dfc6b0a-667a-4a2b-8b74-8f2898223895"
const CANCELLATION_REQUEST = "c8738102-e019-49cb-98f0-5c480540f70f"
const SECOND_CANCELLATION_REQUEST = "f0e1c9d6-c02e-42e8-a9ae-4fcf57e1cdd4"
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

describe("subscription checkout cancellation", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the test adapter implements the D1 subset used here
    const db = drizzleDb as unknown as Database.TxOrDb
    const workspaceID = "wrk_cancellation_test"
    const accountID = "acc_cancellation_test"
    sqlite.query("insert into account (id) values (?)").run(accountID)
    sqlite.query("insert into workspace (id, name) values (?, ?)").run(workspaceID, "Cancellation test")
    sqlite
      .query("insert into user (id, workspace_id, account_id, name, role) values (?, ?, ?, ?, ?)")
      .run("usr_cancellation_test", workspaceID, accountID, "", "admin")
    sqlite
      .query("insert into billing (id, workspace_id, balance) values (?, ?, ?)")
      .run("bil_cancellation_test", workspaceID, 0)

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

    async function createCheckout(
      provider: "qpay" | "bonum",
      cancelInvoice: PaymentCancellationAdapter["cancelInvoice"],
    ) {
      const merchantAccountID = `${provider}_merchant_cancellation_test`
      const externalInvoiceID = `${provider}_external_cancellation_test`
      const adapter: PaymentCancellationAdapter = {
        provider,
        merchantAccountID,
        async createInvoice() {
          return { provider, merchantAccountID, externalInvoiceID, deepLinks: [] }
        },
        cancelInvoice,
      }
      const checkout = await createSubscriptionCheckout(
        {
          workspaceID,
          accountID,
          requestKey: CHECKOUT_REQUEST,
          provider,
          plan: "pro",
        },
        { adapter, catalog, transaction, now: () => NOW },
      )
      return { adapter, checkout, externalInvoiceID, merchantAccountID }
    }

    return { sqlite, db, workspaceID, accountID, transaction, createCheckout }
  }

  function request(workspaceID: string, accountID: string, invoiceID: string, requestKey = CANCELLATION_REQUEST) {
    return { workspaceID, accountID, invoiceID, requestKey }
  }

  test("reserves before one QPay mutation and replays the deterministic cancellation event", async () => {
    const environment = await fixture()
    let providerCalls = 0
    const created = await environment.createCheckout("qpay", async (input) => {
      providerCalls++
      expect(input).toEqual({ externalInvoiceID: "qpay_external_cancellation_test" })
      expect(
        environment.sqlite
          .query("select status from payment_cancellation where invoice_id = ?")
          .get(created.checkout.invoiceID),
      ).toEqual({ status: "requested" })
      return {
        provider: "qpay",
        merchantAccountID: created.merchantAccountID,
        externalInvoiceID: input.externalInvoiceID,
      }
    })
    const dependencies = {
      adapters: { qpay: created.adapter },
      transaction: environment.transaction,
      now: () => NOW,
    }

    const first = await cancelSubscriptionCheckout(
      request(environment.workspaceID, environment.accountID, created.checkout.invoiceID),
      dependencies,
    )
    const replay = await cancelSubscriptionCheckout(
      request(environment.workspaceID, environment.accountID, created.checkout.invoiceID, SECOND_CANCELLATION_REQUEST),
      dependencies,
    )

    expect(providerCalls).toBe(1)
    expect(first.result).toEqual({ invoiceID: created.checkout.invoiceID, provider: "qpay", status: "cancelled" })
    expect(first.event).toEqual(replay.event)
    expect(first.event).toMatchObject({
      provider: "qpay",
      merchantAccountID: created.merchantAccountID,
      externalInvoiceID: created.externalInvoiceID,
      type: "cancelled",
      occurredAt: NOW,
    })
    expect(first.event?.externalEventID).toHaveLength(64)
    expect(first.event?.payloadHash).toHaveLength(64)
    expect(
      environment.sqlite
        .query("select status, error_code, time_requested, time_completed from payment_cancellation")
        .get(),
    ).toEqual({ status: "cancelled", error_code: null, time_requested: NOW, time_completed: NOW })
    expect(environment.sqlite.query("select status from payment_checkout").get()).toEqual({ status: "ready" })
    expect(await getSubscriptionBillingOverviewWithDb(environment.db, environment.workspaceID, NOW)).toMatchObject({
      checkout: {
        invoiceID: created.checkout.invoiceID,
        cancellation: { status: "cancelled", errorCode: null },
      },
    })
  })

  test("requires an active administrator and rejects unsupported Bonum cancellation before mutation", async () => {
    const unauthorized = await fixture()
    let unauthorizedCalls = 0
    const qpay = await unauthorized.createCheckout("qpay", async () => {
      unauthorizedCalls++
      throw new Error("must not be called")
    })
    unauthorized.sqlite.query("update user set role = 'member' where account_id = ?").run(unauthorized.accountID)
    const authorizationError = await cancelSubscriptionCheckout(
      request(unauthorized.workspaceID, unauthorized.accountID, qpay.checkout.invoiceID),
      { adapters: { qpay: qpay.adapter }, transaction: unauthorized.transaction, now: () => NOW },
    ).catch((error) => error)

    expect(authorizationError).toBeInstanceOf(PaymentCancellationAuthorizationError)
    expect(unauthorizedCalls).toBe(0)
    expect(unauthorized.sqlite.query("select count(*) as count from payment_cancellation").get()).toEqual({ count: 0 })

    const unsupported = await fixture()
    let bonumCalls = 0
    const bonum = await unsupported.createCheckout("bonum", async () => {
      bonumCalls++
      throw new Error("must not be called")
    })
    const unsupportedError = await cancelSubscriptionCheckout(
      request(unsupported.workspaceID, unsupported.accountID, bonum.checkout.invoiceID),
      { adapters: { bonum: bonum.adapter }, transaction: unsupported.transaction, now: () => NOW },
    ).catch((error) => error)

    expect(unsupportedError).toBeInstanceOf(PaymentCancellationUnsupportedError)
    expect(bonumCalls).toBe(0)
    expect(unsupported.sqlite.query("select count(*) as count from payment_cancellation").get()).toEqual({ count: 0 })
  })

  test("records an uncertain provider result and never repeats the QPay mutation", async () => {
    const environment = await fixture()
    let providerCalls = 0
    const created = await environment.createCheckout("qpay", async () => {
      providerCalls++
      throw new PaymentProviderResponseError({ provider: "qpay", operation: "cancel invoice", status: 503 })
    })
    const dependencies = {
      adapters: { qpay: created.adapter },
      transaction: environment.transaction,
      now: () => NOW,
    }
    const cancellationRequest = request(environment.workspaceID, environment.accountID, created.checkout.invoiceID)

    const first = await cancelSubscriptionCheckout(cancellationRequest, dependencies).catch((error) => error)
    const replay = await cancelSubscriptionCheckout(cancellationRequest, dependencies).catch((error) => error)

    expect(first).toBeInstanceOf(PaymentCancellationOperationError)
    expect(first).toMatchObject({ state: "unknown", code: "provider_503" })
    expect(replay).toBeInstanceOf(PaymentCancellationConflictError)
    expect(replay).toMatchObject({ state: "result_unknown" })
    expect(providerCalls).toBe(1)
    expect(environment.sqlite.query("select status, error_code from payment_cancellation").get()).toEqual({
      status: "unknown",
      error_code: "provider_503",
    })
  })

  test("marks a definite credential rejection failed without retrying the provider", async () => {
    const environment = await fixture()
    let providerCalls = 0
    const created = await environment.createCheckout("qpay", async () => {
      providerCalls++
      throw new PaymentProviderResponseError({ provider: "qpay", operation: "cancel invoice", status: 401 })
    })
    const dependencies = {
      adapters: { qpay: created.adapter },
      transaction: environment.transaction,
      now: () => NOW,
    }
    const cancellationRequest = request(environment.workspaceID, environment.accountID, created.checkout.invoiceID)

    const first = await cancelSubscriptionCheckout(cancellationRequest, dependencies).catch((error) => error)
    const replay = await cancelSubscriptionCheckout(cancellationRequest, dependencies).catch((error) => error)

    expect(first).toMatchObject({ state: "failed", code: "provider_401" })
    expect(replay).toMatchObject({ state: "request_failed" })
    expect(providerCalls).toBe(1)
    expect(
      environment.sqlite.query("select status, error_code, time_completed from payment_cancellation").get(),
    ).toEqual({
      status: "failed",
      error_code: "provider_401",
      time_completed: NOW,
    })
  })

  test("turns an abandoned reservation into unknown without calling QPay", async () => {
    const environment = await fixture()
    let providerCalls = 0
    const created = await environment.createCheckout("qpay", async () => {
      providerCalls++
      throw new Error("must not be called")
    })
    environment.sqlite
      .query(
        `insert into payment_cancellation
          (invoice_id, workspace_id, account_id, request_key, provider, merchant_account_id, external_invoice_id, status, time_requested)
         values (?, ?, ?, ?, ?, ?, ?, 'requested', ?)`,
      )
      .run(
        created.checkout.invoiceID,
        environment.workspaceID,
        environment.accountID,
        CANCELLATION_REQUEST,
        "qpay",
        created.merchantAccountID,
        created.externalInvoiceID,
        NOW,
      )

    const error = await cancelSubscriptionCheckout(
      request(environment.workspaceID, environment.accountID, created.checkout.invoiceID),
      {
        adapters: { qpay: created.adapter },
        transaction: environment.transaction,
        now: () => NOW + 2 * 60_000,
      },
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(PaymentCancellationConflictError)
    expect(error).toMatchObject({ state: "result_unknown" })
    expect(providerCalls).toBe(0)
    expect(environment.sqlite.query("select status, error_code from payment_cancellation").get()).toEqual({
      status: "unknown",
      error_code: "provider_result_unknown",
    })
  })

  test("does not cancel an invoice after a verified settlement", async () => {
    const environment = await fixture()
    let providerCalls = 0
    const created = await environment.createCheckout("qpay", async () => {
      providerCalls++
      throw new Error("must not be called")
    })
    environment.sqlite.query("update payment_checkout set status = 'paid' where id = ?").run(created.checkout.invoiceID)
    environment.sqlite.query("update payment_invoice set status = 'paid' where id = ?").run(created.checkout.invoiceID)

    const error = await cancelSubscriptionCheckout(
      request(environment.workspaceID, environment.accountID, created.checkout.invoiceID),
      { adapters: { qpay: created.adapter }, transaction: environment.transaction, now: () => NOW },
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(PaymentCancellationConflictError)
    expect(error).toMatchObject({ state: "settled" })
    expect(providerCalls).toBe(0)
    expect(environment.sqlite.query("select count(*) as count from payment_cancellation").get()).toEqual({ count: 0 })
  })

  test("retries only local completion when the committed response is lost", async () => {
    const environment = await fixture()
    let providerCalls = 0
    let transactionCalls = 0
    const created = await environment.createCheckout("qpay", async (input) => {
      providerCalls++
      return {
        provider: "qpay",
        merchantAccountID: "qpay_merchant_cancellation_test",
        externalInvoiceID: input.externalInvoiceID,
      }
    })

    const result = await cancelSubscriptionCheckout(
      request(environment.workspaceID, environment.accountID, created.checkout.invoiceID),
      {
        adapters: { qpay: created.adapter },
        transaction: async (callback) => {
          transactionCalls++
          const value = await environment.transaction(callback)
          if (transactionCalls === 2) throw new Error("committed response was lost")
          return value
        },
        now: () => NOW,
      },
    )

    expect(result.result.status).toBe("cancelled")
    expect(providerCalls).toBe(1)
    expect(transactionCalls).toBe(3)
  })

  test("fails closed on a mismatched provider receipt and does not mutate twice", async () => {
    const environment = await fixture()
    let providerCalls = 0
    const created = await environment.createCheckout("qpay", async () => {
      providerCalls++
      return {
        provider: "qpay",
        merchantAccountID: "qpay_merchant_cancellation_test",
        externalInvoiceID: "different_external_invoice",
      } satisfies PaymentInvoiceCancellationReceipt
    })
    const dependencies = {
      adapters: { qpay: created.adapter },
      transaction: environment.transaction,
      now: () => NOW,
    }
    const cancellationRequest = request(environment.workspaceID, environment.accountID, created.checkout.invoiceID)

    const first = await cancelSubscriptionCheckout(cancellationRequest, dependencies).catch((error) => error)
    const replay = await cancelSubscriptionCheckout(cancellationRequest, dependencies).catch((error) => error)

    expect(first).toMatchObject({ state: "unknown", code: "persistence_failed" })
    expect(replay).toMatchObject({ state: "result_unknown" })
    expect(providerCalls).toBe(1)
    expect(environment.sqlite.query("select status, error_code from payment_cancellation").get()).toEqual({
      status: "unknown",
      error_code: "persistence_failed",
    })
  })
})
