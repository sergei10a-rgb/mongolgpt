import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { Database } from "../src/drizzle"
import {
  addUtcCalendarMonths,
  createPlanSubscriptionPaymentEffect,
  expirePlanSubscriptionsWithDb,
} from "../src/payment-entitlement"
import { applyPaymentEventWithDb, recordPaymentInvoiceWithDb } from "../src/payment-ledger"
import { recordPlanUsageWithDb } from "../src/plan-usage"
import * as schema from "../src/schema-d1"

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

const hash = (character: string) => character.repeat(64)

describe("paid plan subscription entitlement", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    const db = drizzleDb as unknown as Database.TxOrDb
    const workspaceID = "wrk_entitlement_test"
    const merchantAccountID = "merchant_entitlement_test"
    sqlite.query("insert into workspace (id, name) values (?, ?)").run(workspaceID, "Entitlement test")
    sqlite
      .query("insert into billing (id, workspace_id, balance) values (?, ?, ?)")
      .run("bil_entitlement_test", workspaceID, 0)
    sqlite
      .query("insert into user (id, workspace_id, name, role) values (?, ?, ?, ?)")
      .run("usr_entitlement_admin", workspaceID, "Admin", "admin")
    sqlite
      .query("insert into user (id, workspace_id, name, role) values (?, ?, ?, ?)")
      .run("usr_entitlement_member", workspaceID, "Member", "member")

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

    return { sqlite, db, workspaceID, merchantAccountID, transaction }
  }

  test("activates once, then revokes the current entitlement on a verified refund", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    const paidAt = Date.UTC(2026, 6, 20, 8)
    const invoice = await recordPaymentInvoiceWithDb(db, {
      id: "inv_entitlement_primary",
      workspaceID,
      provider: "qpay",
      merchantAccountID,
      externalInvoiceID: "qpay_entitlement_primary",
      purpose: "subscription",
      plan: "pro",
      amount: 39_000,
    })
    const effect = createPlanSubscriptionPaymentEffect({ now: () => paidAt + 1_000 })
    const paid = {
      provider: "qpay" as const,
      merchantAccountID,
      externalEventID: "qpay_entitlement_paid",
      externalInvoiceID: invoice.invoice.external_invoice_id,
      externalPaymentID: "qpay_payment_primary",
      amount: 39_000,
      currency: "MNT" as const,
      type: "paid" as const,
      payloadHash: hash("a"),
      occurredAt: paidAt,
    }

    await expect(transaction((tx) => applyPaymentEventWithDb(tx, paid, effect))).resolves.toMatchObject({
      kind: "applied",
    })
    await expect(transaction((tx) => applyPaymentEventWithDb(tx, paid, effect))).resolves.toMatchObject({
      kind: "duplicate",
    })

    const entitlement = sqlite
      .query("select invoice_id, plan, status, time_period_start, time_period_end from plan_subscription")
      .get() as Record<string, unknown>
    expect(entitlement).toEqual({
      invoice_id: invoice.invoice.id,
      plan: "pro",
      status: "active",
      time_period_start: paidAt,
      time_period_end: addUtcCalendarMonths(paidAt, 1),
    })
    expect(sqlite.query("select count(*) as count from subscription").get()).toEqual({ count: 2 })
    const billing = sqlite.query("select subscription_id, subscription from billing").get() as {
      subscription_id: string
      subscription: string
    }
    expect(JSON.parse(billing.subscription)).toMatchObject({
      status: "subscribed",
      plan: "pro",
      source: "qpay",
      invoiceID: invoice.invoice.id,
      currentPeriodStart: paidAt,
      currentPeriodEnd: addUtcCalendarMonths(paidAt, 1),
    })

    await expect(
      transaction((tx) =>
        applyPaymentEventWithDb(
          tx,
          {
            ...paid,
            externalEventID: "qpay_entitlement_refunded",
            type: "refunded",
            payloadHash: hash("b"),
            occurredAt: paidAt + 86_400_000,
          },
          effect,
        ),
      ),
    ).resolves.toMatchObject({ kind: "applied" })

    expect(sqlite.query("select status from plan_subscription").get()).toEqual({ status: "refunded" })
    expect(sqlite.query("select subscription_id, subscription from billing").get()).toEqual({
      subscription_id: null,
      subscription: null,
    })
    expect(sqlite.query("select count(*) as count from subscription").get()).toEqual({ count: 0 })
  })

  test("rolls back a second paid invoice while another entitlement is active", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    const paidAt = Date.UTC(2026, 6, 20, 8)
    const effect = createPlanSubscriptionPaymentEffect({ now: () => paidAt + 1_000 })

    for (const index of [1, 2]) {
      await recordPaymentInvoiceWithDb(db, {
        id: `inv_entitlement_${index}`,
        workspaceID,
        provider: "bonum",
        merchantAccountID,
        externalInvoiceID: `bonum_entitlement_${index}`,
        purpose: "subscription",
        plan: index === 1 ? "basic" : "max",
        amount: index === 1 ? 19_000 : 99_000,
      })
    }

    const applyPaid = (index: number) =>
      transaction((tx) =>
        applyPaymentEventWithDb(
          tx,
          {
            provider: "bonum",
            merchantAccountID,
            externalEventID: `bonum_entitlement_paid_${index}`,
            externalInvoiceID: `bonum_entitlement_${index}`,
            externalPaymentID: `bonum_payment_${index}`,
            amount: index === 1 ? 19_000 : 99_000,
            currency: "MNT",
            type: "paid",
            payloadHash: hash(index === 1 ? "c" : "d"),
            occurredAt: paidAt + index,
          },
          effect,
        ),
      )

    await expect(applyPaid(1)).resolves.toMatchObject({ kind: "applied" })
    await expect(applyPaid(2)).rejects.toThrow("аль хэдийн идэвхтэй багцын захиалга байна")
    expect(
      sqlite.query("select status from payment_invoice where external_invoice_id = ?").get("bonum_entitlement_2"),
    ).toEqual({ status: "created" })
    expect(
      sqlite
        .query("select count(*) as count from payment_event where external_event_id = ?")
        .get("bonum_entitlement_paid_2"),
    ).toEqual({ count: 0 })
  })

  test("expires entitlements in a bounded transaction and clears plan usage", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    const paidAt = Date.UTC(2026, 0, 31, 12)
    const periodEnd = addUtcCalendarMonths(paidAt, 1)
    expect(new Date(periodEnd).toISOString()).toBe("2026-02-28T12:00:00.000Z")
    const invoice = await recordPaymentInvoiceWithDb(db, {
      workspaceID,
      provider: "qpay",
      merchantAccountID,
      externalInvoiceID: "qpay_entitlement_expiry",
      purpose: "subscription",
      plan: "basic",
      amount: 19_000,
    })
    const effect = createPlanSubscriptionPaymentEffect({ now: () => paidAt + 1_000 })
    await transaction((tx) =>
      applyPaymentEventWithDb(
        tx,
        {
          provider: "qpay",
          merchantAccountID,
          externalEventID: "qpay_entitlement_expiry_paid",
          externalInvoiceID: invoice.invoice.external_invoice_id,
          externalPaymentID: "qpay_payment_expiry",
          amount: 19_000,
          currency: "MNT",
          type: "paid",
          payloadHash: hash("e"),
          occurredAt: paidAt,
        },
        effect,
      ),
    )

    await expect(transaction((tx) => expirePlanSubscriptionsWithDb(tx, periodEnd, 10))).resolves.toBe(1)
    expect(sqlite.query("select status from plan_subscription").get()).toEqual({ status: "expired" })
    expect(sqlite.query("select subscription from billing").get()).toEqual({ subscription: null })
    expect(sqlite.query("select count(*) as count from subscription").get()).toEqual({ count: 0 })
  })

  test("clamps a provider timestamp in the future to the verified processing time", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    const verifiedAt = Date.UTC(2026, 6, 20, 8)
    const providerTimestamp = verifiedAt + 86_400_000
    const invoice = await recordPaymentInvoiceWithDb(db, {
      workspaceID,
      provider: "qpay",
      merchantAccountID,
      externalInvoiceID: "qpay_entitlement_future",
      purpose: "subscription",
      plan: "max",
      amount: 99_000,
    })

    await transaction((tx) =>
      applyPaymentEventWithDb(
        tx,
        {
          provider: "qpay",
          merchantAccountID,
          externalEventID: "qpay_entitlement_future_paid",
          externalInvoiceID: invoice.invoice.external_invoice_id,
          externalPaymentID: "qpay_payment_future",
          amount: 99_000,
          currency: "MNT",
          type: "paid",
          payloadHash: hash("f"),
          occurredAt: providerTimestamp,
        },
        createPlanSubscriptionPaymentEffect({ now: () => verifiedAt }),
      ),
    )

    expect(sqlite.query("select time_period_start, time_period_end from plan_subscription").get()).toEqual({
      time_period_start: verifiedAt,
      time_period_end: addUtcCalendarMonths(verifiedAt, 1),
    })
  })

  test("creates usage for a later workspace member but cannot revive it after refund", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    const paidAt = Date.UTC(2026, 6, 20, 8)
    const invoice = await recordPaymentInvoiceWithDb(db, {
      workspaceID,
      provider: "bonum",
      merchantAccountID,
      externalInvoiceID: "bonum_entitlement_late_member",
      purpose: "subscription",
      plan: "pro",
      amount: 39_000,
    })
    const effect = createPlanSubscriptionPaymentEffect({ now: () => paidAt + 1_000 })
    const paid = {
      provider: "bonum" as const,
      merchantAccountID,
      externalEventID: "bonum_entitlement_late_member_paid",
      externalInvoiceID: invoice.invoice.external_invoice_id,
      externalPaymentID: "bonum_payment_late_member",
      amount: 39_000,
      currency: "MNT" as const,
      type: "paid" as const,
      payloadHash: hash("7"),
      occurredAt: paidAt,
    }
    await transaction((tx) => applyPaymentEventWithDb(tx, paid, effect))
    const entitlement = sqlite.query("select id from plan_subscription").get() as { id: string }

    sqlite
      .query("insert into user (id, workspace_id, name, role) values (?, ?, ?, ?)")
      .run("usr_entitlement_late", workspaceID, "Late member", "member")
    await expect(
      transaction((tx) =>
        recordPlanUsageWithDb(tx, {
          workspaceID,
          userID: "usr_entitlement_late",
          entitlementID: entitlement.id,
          costInMicroCents: 125,
          tokens: 500,
          rollingWindowHours: 5,
          now: new Date(paidAt + 2_000),
        }),
      ),
    ).resolves.toBe(true)
    expect(
      sqlite
        .query(
          "select fixed_usage, weekly_tokens, weekly_requests, monthly_cost, monthly_tokens, monthly_requests from subscription where user_id = ?",
        )
        .get("usr_entitlement_late"),
    ).toEqual({
      fixed_usage: 125,
      weekly_tokens: 500,
      weekly_requests: 1,
      monthly_cost: 125,
      monthly_tokens: 500,
      monthly_requests: 1,
    })

    await transaction((tx) =>
      applyPaymentEventWithDb(
        tx,
        {
          ...paid,
          externalEventID: "bonum_entitlement_late_member_refunded",
          type: "refunded",
          payloadHash: hash("8"),
          occurredAt: paidAt + 3_000,
        },
        effect,
      ),
    )
    await expect(
      transaction((tx) =>
        recordPlanUsageWithDb(tx, {
          workspaceID,
          userID: "usr_entitlement_late",
          entitlementID: entitlement.id,
          costInMicroCents: 125,
          tokens: 500,
          rollingWindowHours: 5,
          now: new Date(paidAt + 4_000),
        }),
      ),
    ).resolves.toBe(false)
    expect(sqlite.query("select count(*) as count from subscription").get()).toEqual({ count: 0 })
  })

  test("tracks weekly and anchored monthly counters, then resets monthly values on the next billing cycle", async () => {
    const { sqlite, workspaceID, transaction } = await fixture()
    const anchor = Date.UTC(2026, 6, 20, 8)
    sqlite
      .query(
        `insert into plan_subscription
          (id, workspace_id, invoice_id, plan, status, time_period_start, time_period_end)
         values (?, ?, ?, 'pro', 'active', ?, ?)`,
      )
      .run("sub_monthly_anchor", workspaceID, "inv_monthly_anchor", anchor, Date.UTC(2026, 9, 20, 8))
    sqlite
      .query("insert into subscription (id, workspace_id, user_id) values (?, ?, ?)")
      .run("sub_usage_monthly_anchor", workspaceID, "usr_entitlement_admin")
    const firstUsageAt = Date.UTC(2026, 7, 18, 12)
    const secondUsageAt = Date.UTC(2026, 7, 25, 12)

    await transaction((tx) =>
      recordPlanUsageWithDb(tx, {
        workspaceID,
        userID: "usr_entitlement_admin",
        entitlementID: "sub_monthly_anchor",
        costInMicroCents: 125,
        tokens: 500,
        rollingWindowHours: 5,
        now: new Date(firstUsageAt),
      }),
    )
    await transaction((tx) =>
      recordPlanUsageWithDb(tx, {
        workspaceID,
        userID: "usr_entitlement_admin",
        entitlementID: "sub_monthly_anchor",
        costInMicroCents: 200,
        tokens: 600,
        rollingWindowHours: 5,
        now: new Date(secondUsageAt),
      }),
    )

    expect(
      sqlite
        .query(
          `select
             fixed_usage,
             weekly_tokens,
             weekly_requests,
             monthly_cost,
             monthly_tokens,
             monthly_requests
           from subscription
           where user_id = ?`,
        )
        .get("usr_entitlement_admin"),
    ).toEqual({
      fixed_usage: 200,
      weekly_tokens: 600,
      weekly_requests: 1,
      monthly_cost: 200,
      monthly_tokens: 600,
      monthly_requests: 1,
    })
  })

  test("clears the new persisted counters when a replacement entitlement activates after expiry", async () => {
    const { sqlite, db, workspaceID, merchantAccountID, transaction } = await fixture()
    const firstPaidAt = Date.UTC(2026, 6, 20, 8)
    const firstInvoice = await recordPaymentInvoiceWithDb(db, {
      id: "inv_entitlement_reset_first",
      workspaceID,
      provider: "bonum",
      merchantAccountID,
      externalInvoiceID: "bonum_entitlement_reset_first",
      purpose: "subscription",
      plan: "basic",
      amount: 19_000,
    })
    await transaction((tx) =>
      applyPaymentEventWithDb(
        tx,
        {
          provider: "bonum",
          merchantAccountID,
          externalEventID: "bonum_entitlement_reset_first_paid",
          externalInvoiceID: firstInvoice.invoice.external_invoice_id,
          externalPaymentID: "bonum_payment_reset_first",
          amount: 19_000,
          currency: "MNT",
          type: "paid",
          payloadHash: hash("a"),
          occurredAt: firstPaidAt,
        },
        createPlanSubscriptionPaymentEffect({ now: () => firstPaidAt + 1_000 }),
      ),
    )
    const firstEntitlement = sqlite
      .query("select id, time_period_start, time_period_end from plan_subscription where invoice_id = ?")
      .get(firstInvoice.invoice.id) as { id: string; time_period_start: number; time_period_end: number }

    await transaction((tx) =>
      recordPlanUsageWithDb(tx, {
        workspaceID,
        userID: "usr_entitlement_admin",
        entitlementID: firstEntitlement.id,
        costInMicroCents: 125,
        tokens: 500,
        rollingWindowHours: 5,
        now: new Date(firstPaidAt + 2_000),
      }),
    )

    const secondInvoice = await recordPaymentInvoiceWithDb(db, {
      id: "inv_entitlement_reset_second",
      workspaceID,
      provider: "bonum",
      merchantAccountID,
      externalInvoiceID: "bonum_entitlement_reset_second",
      purpose: "subscription",
      plan: "pro",
      amount: 39_000,
    })
    const secondPaidAt = firstEntitlement.time_period_end + 1_000
    await transaction((tx) =>
      applyPaymentEventWithDb(
        tx,
        {
          provider: "bonum",
          merchantAccountID,
          externalEventID: "bonum_entitlement_reset_second_paid",
          externalInvoiceID: secondInvoice.invoice.external_invoice_id,
          externalPaymentID: "bonum_payment_reset_second",
          amount: 39_000,
          currency: "MNT",
          type: "paid",
          payloadHash: hash("b"),
          occurredAt: secondPaidAt,
        },
        createPlanSubscriptionPaymentEffect({ now: () => secondPaidAt + 1_000 }),
      ),
    )

    expect(
      sqlite
        .query(
          `select
             fixed_usage,
             weekly_tokens,
             weekly_requests,
             monthly_cost,
             monthly_tokens,
             monthly_requests,
             time_fixed_updated,
             time_weekly_tokens_updated,
             time_weekly_requests_updated,
             time_monthly_cost_updated,
             time_monthly_tokens_updated,
             time_monthly_requests_updated
           from subscription
           where user_id = ?`,
        )
        .get("usr_entitlement_admin"),
    ).toEqual({
      fixed_usage: null,
      weekly_tokens: null,
      weekly_requests: null,
      monthly_cost: null,
      monthly_tokens: null,
      monthly_requests: null,
      time_fixed_updated: null,
      time_weekly_tokens_updated: null,
      time_weekly_requests_updated: null,
      time_monthly_cost_updated: null,
      time_monthly_tokens_updated: null,
      time_monthly_requests_updated: null,
    })
  })
})
