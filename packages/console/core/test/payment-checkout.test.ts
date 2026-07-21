import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import {
  createSubscriptionCheckout,
  expireOpenPaymentCheckoutsWithDb,
  getSubscriptionBillingOverviewWithDb,
  PaymentCheckoutAuthorizationError,
  PaymentCheckoutConflictError,
  PaymentCheckoutCreationError,
  syncPaymentCheckoutStatusWithDb,
  type PaymentPlanCatalog,
} from "../src/payment-checkout"
import { PaymentProviderResponseError, type PaymentProviderAdapter } from "../src/payment-provider"
import { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

const NOW = Date.UTC(2026, 6, 21, 12)
const REQUEST_A = "6dfc6b0a-667a-4a2b-8b74-8f2898223895"
const REQUEST_B = "c8738102-e019-49cb-98f0-5c480540f70f"
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

describe("subscription payment checkout", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the test adapter implements the D1 subset used here
    const db = drizzleDb as unknown as Database.TxOrDb
    const workspaceID = "wrk_checkout_test"
    const accountID = "acc_checkout_test"
    sqlite.query("insert into account (id) values (?)").run(accountID)
    sqlite.query("insert into workspace (id, name) values (?, ?)").run(workspaceID, "Checkout test")
    sqlite
      .query("insert into user (id, workspace_id, account_id, name, role) values (?, ?, ?, ?, ?)")
      .run("usr_checkout_test", workspaceID, accountID, "", "admin")
    sqlite
      .query("insert into billing (id, workspace_id, balance) values (?, ?, ?)")
      .run("bil_checkout_test", workspaceID, 0)

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

    return { sqlite, db, workspaceID, accountID, transaction }
  }

  function adapter(
    createInvoice: PaymentProviderAdapter["createInvoice"],
    provider: PaymentProviderAdapter["provider"] = "qpay",
  ): PaymentProviderAdapter {
    return { provider, merchantAccountID: `${provider}_merchant_test`, createInvoice }
  }

  function request(workspaceID: string, accountID: string, requestKey = REQUEST_A) {
    return { workspaceID, accountID, requestKey, provider: "qpay" as const, plan: "pro" as const }
  }

  test("reserves before the provider call and replays one ready checkout", async () => {
    const { sqlite, db, workspaceID, accountID, transaction } = await fixture()
    const calls: Array<Record<string, unknown>> = []
    const provider = adapter(async (input) => {
      calls.push(input)
      expect(sqlite.query("select status from payment_checkout where id = ?").get(input.reference)).toEqual({
        status: "creating",
      })
      return {
        provider: "qpay",
        merchantAccountID: "qpay_merchant_test",
        externalInvoiceID: "qpay_checkout_1",
        qrText: "qpay-qr",
        deepLinks: [{ name: "Банк", description: "", link: "khanbank://q?qpay-qr" }],
      }
    })
    const dependencies = { adapter: provider, catalog, transaction, now: () => NOW }

    const first = await createSubscriptionCheckout(request(workspaceID, accountID), dependencies)
    const replay = await createSubscriptionCheckout(request(workspaceID, accountID), dependencies)

    expect(replay).toEqual(first)
    expect(calls).toHaveLength(1)
    expect(first).toMatchObject({ status: "ready", provider: "qpay", plan: "pro", amount: 49_000 })
    expect(sqlite.query("select status, external_invoice_id from payment_checkout").get()).toEqual({
      status: "ready",
      external_invoice_id: "qpay_checkout_1",
    })
    expect(sqlite.query("select id, status, external_invoice_id from payment_invoice").get()).toEqual({
      id: first.invoiceID,
      status: "created",
      external_invoice_id: "qpay_checkout_1",
    })
    expect(await getSubscriptionBillingOverviewWithDb(db, workspaceID, NOW)).toEqual({
      subscription: null,
      checkout: {
        ...first,
        createdAt: NOW,
        cancellation: null,
      },
    })
  })

  test("requires an active workspace administrator before reserving or calling the provider", async () => {
    const { sqlite, workspaceID, accountID, transaction } = await fixture()
    let calls = 0
    const dependencies = {
      adapter: adapter(async () => {
        calls++
        throw new Error("must not be called")
      }),
      catalog,
      transaction,
      now: () => NOW,
    }

    const unrelated = await createSubscriptionCheckout(request(workspaceID, "acc_unrelated_user"), dependencies).catch(
      (error) => error,
    )
    sqlite.query("update user set role = 'member' where account_id = ?").run(accountID)
    const member = await createSubscriptionCheckout(request(workspaceID, accountID, REQUEST_B), dependencies).catch(
      (error) => error,
    )

    expect(unrelated).toBeInstanceOf(PaymentCheckoutAuthorizationError)
    expect(member).toBeInstanceOf(PaymentCheckoutAuthorizationError)
    expect(calls).toBe(0)
    expect(sqlite.query("select count(*) as count from payment_checkout").get()).toEqual({ count: 0 })
  })

  test("retries only local completion when the provider response was already created", async () => {
    const { sqlite, workspaceID, accountID, transaction } = await fixture()
    let providerCalls = 0
    let transactions = 0
    const result = await createSubscriptionCheckout(request(workspaceID, accountID), {
      adapter: adapter(async () => {
        providerCalls++
        return {
          provider: "qpay",
          merchantAccountID: "qpay_merchant_test",
          externalInvoiceID: "qpay_checkout_committed",
          deepLinks: [],
        }
      }),
      catalog,
      transaction: async (callback) => {
        transactions++
        const value = await transaction(callback)
        if (transactions === 2) throw new Error("committed response was lost")
        return value
      },
      now: () => NOW,
    })

    expect(result).toMatchObject({ status: "ready", invoiceID: result.invoiceID })
    expect(providerCalls).toBe(1)
    expect(transactions).toBe(3)
    expect(sqlite.query("select status, external_invoice_id from payment_checkout").get()).toEqual({
      status: "ready",
      external_invoice_id: "qpay_checkout_committed",
    })
  })

  test("blocks conflicting request replays and parallel open subscriptions", async () => {
    const { workspaceID, accountID, transaction } = await fixture()
    let calls = 0
    const dependencies = {
      adapter: adapter(async () => {
        calls++
        return {
          provider: "qpay",
          merchantAccountID: "qpay_merchant_test",
          externalInvoiceID: `qpay_checkout_${calls}`,
          deepLinks: [],
        }
      }),
      catalog,
      transaction,
      now: () => NOW,
    }
    await createSubscriptionCheckout(request(workspaceID, accountID), dependencies)

    const replayError = await createSubscriptionCheckout(
      { ...request(workspaceID, accountID), plan: "max" },
      dependencies,
    ).catch((error) => error)
    expect(replayError).toBeInstanceOf(Error)
    if (!(replayError instanceof Error)) throw new Error("Expected a replay conflict")
    expect(replayError.message).toContain("request replay conflicts")
    const conflict = await createSubscriptionCheckout(request(workspaceID, accountID, REQUEST_B), dependencies).catch(
      (error) => error,
    )
    expect(conflict).toBeInstanceOf(PaymentCheckoutConflictError)
    expect(conflict.state).toBe("open_checkout")
    expect(calls).toBe(1)
  })

  test("distinguishes definite provider rejection from an uncertain result", async () => {
    const definite = await fixture()
    const rejected = {
      adapter: adapter(async () => {
        throw new PaymentProviderResponseError({ provider: "qpay", operation: "create invoice", status: 400 })
      }),
      catalog,
      transaction: definite.transaction,
      now: () => NOW,
    }
    const definiteError = await createSubscriptionCheckout(
      request(definite.workspaceID, definite.accountID),
      rejected,
    ).catch((error) => error)
    expect(definiteError).toBeInstanceOf(PaymentCheckoutCreationError)
    expect(definiteError).toMatchObject({ state: "failed", code: "provider_400" })
    expect(definite.sqlite.query("select status, creation_error_code from payment_checkout").get()).toEqual({
      status: "failed",
      creation_error_code: "provider_400",
    })

    const uncertain = await fixture()
    const unavailable = {
      adapter: adapter(async () => {
        throw new PaymentProviderResponseError({ provider: "qpay", operation: "create invoice", status: 503 })
      }),
      catalog,
      transaction: uncertain.transaction,
      now: () => NOW,
    }
    const uncertainError = await createSubscriptionCheckout(
      request(uncertain.workspaceID, uncertain.accountID),
      unavailable,
    ).catch((error) => error)
    expect(uncertainError).toBeInstanceOf(PaymentCheckoutCreationError)
    expect(uncertainError).toMatchObject({ state: "unknown", code: "provider_503" })
    const duplicate = await createSubscriptionCheckout(
      request(uncertain.workspaceID, uncertain.accountID, REQUEST_B),
      unavailable,
    ).catch((error) => error)
    expect(duplicate).toMatchObject({ state: "open_checkout" })
  })

  test("expires abandoned intents after the provider grace window", async () => {
    const { sqlite, db, workspaceID, accountID, transaction } = await fixture()
    const unavailable = {
      adapter: adapter(async () => {
        throw new Error("network timeout")
      }),
      catalog,
      transaction,
      now: () => NOW,
    }
    const uncertain = await createSubscriptionCheckout(request(workspaceID, accountID), unavailable).catch(
      (error) => error,
    )
    expect(uncertain).toMatchObject({ state: "unknown" })

    expect(await expireOpenPaymentCheckoutsWithDb(db, NOW + 19 * 60_000)).toBe(0)
    expect(await expireOpenPaymentCheckoutsWithDb(db, NOW + 21 * 60_000)).toBe(1)
    expect(sqlite.query("select status from payment_checkout").get()).toEqual({ status: "expired" })
  })

  test("syncs only verified ledger events into checkout lifecycle", async () => {
    const { sqlite, db, workspaceID, accountID, transaction } = await fixture()
    const result = await createSubscriptionCheckout(request(workspaceID, accountID), {
      adapter: adapter(async () => ({
        provider: "qpay",
        merchantAccountID: "qpay_merchant_test",
        externalInvoiceID: "qpay_checkout_sync",
        deepLinks: [],
      })),
      catalog,
      transaction,
      now: () => NOW,
    })

    expect(await syncPaymentCheckoutStatusWithDb(db, result.invoiceID, "pending", NOW + 1_000)).toBe(true)
    expect(await syncPaymentCheckoutStatusWithDb(db, result.invoiceID, "failed", NOW + 2_000)).toBe(true)
    expect(await syncPaymentCheckoutStatusWithDb(db, result.invoiceID, "paid", NOW + 3_000)).toBe(true)
    expect(await syncPaymentCheckoutStatusWithDb(db, result.invoiceID, "refunded", NOW + 4_000)).toBe(true)
    expect(sqlite.query("select status, time_failed, time_paid, time_refunded from payment_checkout").get()).toEqual({
      status: "refunded",
      time_failed: NOW + 2_000,
      time_paid: NOW + 3_000,
      time_refunded: NOW + 4_000,
    })
    const transitionError = await syncPaymentCheckoutStatusWithDb(db, result.invoiceID, "paid", NOW + 5_000).catch(
      (error) => error,
    )
    expect(transitionError).toBeInstanceOf(Error)
    if (!(transitionError instanceof Error)) throw new Error("Expected an invalid transition")
    expect(transitionError.message).toContain("does not match verified event")
  })

  test("repairs an expired or cancelled checkout when a verified payment arrives late", async () => {
    for (const [index, terminalStatus] of (["expired", "cancelled"] as const).entries()) {
      const { sqlite, db, workspaceID, accountID, transaction } = await fixture()
      const result = await createSubscriptionCheckout(request(workspaceID, accountID), {
        adapter: adapter(async () => ({
          provider: "qpay",
          merchantAccountID: "qpay_merchant_test",
          externalInvoiceID: `qpay_late_checkout_${terminalStatus}`,
          deepLinks: [],
        })),
        catalog,
        transaction,
        now: () => NOW,
      })

      expect(await syncPaymentCheckoutStatusWithDb(db, result.invoiceID, terminalStatus, NOW + index + 1)).toBe(true)
      expect(await syncPaymentCheckoutStatusWithDb(db, result.invoiceID, "paid", NOW + index + 10)).toBe(true)
      sqlite
        .query(
          `insert into payment_cancellation
            (invoice_id, workspace_id, account_id, request_key, provider, merchant_account_id,
              external_invoice_id, status, time_requested, time_completed)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          result.invoiceID,
          workspaceID,
          accountID,
          `late-paid-${index}`,
          "qpay",
          "qpay_merchant_test",
          `qpay_late_checkout_${terminalStatus}`,
          "cancelled",
          NOW + index + 2,
          NOW + index + 3,
        )
      expect(sqlite.query("select status, time_paid from payment_checkout").get()).toEqual({
        status: "paid",
        time_paid: NOW + index + 10,
      })
      expect((await getSubscriptionBillingOverviewWithDb(db, workspaceID, NOW)).checkout?.cancellation).toBeNull()
    }
  })

  test("rejects purchase while an active plan entitlement exists", async () => {
    const { sqlite, db, workspaceID, accountID, transaction } = await fixture()
    sqlite
      .query(
        "insert into plan_subscription (id, workspace_id, invoice_id, plan, status, time_period_start, time_period_end) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("sub_checkout_active", workspaceID, "inv_checkout_active", "basic", "active", NOW - 1_000, NOW + 86_400_000)
    let calls = 0
    const error = await createSubscriptionCheckout(request(workspaceID, accountID), {
      adapter: adapter(async () => {
        calls++
        throw new Error("must not be called")
      }),
      catalog,
      transaction,
      now: () => NOW,
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(PaymentCheckoutConflictError)
    expect(error.state).toBe("active_subscription")
    expect(calls).toBe(0)
    expect(await getSubscriptionBillingOverviewWithDb(db, workspaceID, NOW)).toEqual({
      subscription: {
        id: "sub_checkout_active",
        plan: "basic",
        status: "active",
        periodStart: NOW - 1_000,
        periodEnd: NOW + 86_400_000,
      },
      checkout: null,
    })
  })
})
