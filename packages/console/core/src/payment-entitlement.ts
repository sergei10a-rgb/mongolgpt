import { and, asc, Database, eq, isNull, lte } from "./drizzle"
import { Identifier } from "./identifier"
import type { PaymentTransitionEffect } from "./payment-ledger"
import { BillingTable, PlanSubscriptionTable, SubscriptionTable } from "./schema/billing.sql"
import { UserTable } from "./schema/user.sql"

const DEFAULT_PERIOD_MONTHS = 1

export function addUtcCalendarMonths(timestamp: number, months: number) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError("Subscription timestamp is invalid")
  if (!Number.isSafeInteger(months) || months < 1 || months > 12) {
    throw new TypeError("Subscription period is invalid")
  }

  const source = new Date(timestamp)
  const targetMonth = source.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(source.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate()
  return Date.UTC(
    source.getUTCFullYear(),
    targetMonth,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  )
}

export function createPlanSubscriptionPaymentEffect(options: { now?: () => number } = {}): PaymentTransitionEffect {
  const now = options.now ?? Date.now

  return async ({ db, invoice, event }) => {
    if (invoice.purpose !== "subscription") return
    if (event.type === "paid") {
      if (!invoice.plan) throw new Error("Subscription invoice has no plan")
      await activatePlanSubscription(db, {
        workspaceID: invoice.workspace_id,
        invoiceID: invoice.id,
        plan: invoice.plan,
        provider: invoice.provider,
        paidAt: event.occurredAt,
        now: now(),
      })
      return
    }
    if (event.type === "refunded") {
      await refundPlanSubscription(db, {
        workspaceID: invoice.workspace_id,
        invoiceID: invoice.id,
        refundedAt: event.occurredAt,
      })
    }
  }
}

export const applyPlanSubscriptionPaymentEffect = createPlanSubscriptionPaymentEffect()

export async function expirePlanSubscriptionsWithDb(db: Database.TxOrDb, now = Date.now(), limit = 100) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Expiration timestamp is invalid")
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("Expiration limit is invalid")

  const expired = await db
    .select()
    .from(PlanSubscriptionTable)
    .where(
      and(
        eq(PlanSubscriptionTable.status, "active"),
        isNull(PlanSubscriptionTable.timeDeleted),
        lte(PlanSubscriptionTable.timePeriodEnd, new Date(now)),
      ),
    )
    .orderBy(asc(PlanSubscriptionTable.timePeriodEnd))
    .limit(limit)

  let applied = 0
  for (const subscription of expired) {
    const changed = await db
      .update(PlanSubscriptionTable)
      .set({ status: "expired" })
      .where(and(eq(PlanSubscriptionTable.id, subscription.id), eq(PlanSubscriptionTable.status, "active")))
      .returning({ id: PlanSubscriptionTable.id })
    if (changed.length === 0) continue
    await clearWorkspacePlan(db, subscription.workspaceID, subscription.invoiceID)
    applied++
  }
  return applied
}

export function expirePlanSubscriptions(now = Date.now(), limit = 100) {
  return Database.transaction((db) => expirePlanSubscriptionsWithDb(db, now, limit))
}

async function activatePlanSubscription(
  db: Database.TxOrDb,
  input: {
    workspaceID: string
    invoiceID: string
    plan: "basic" | "pro" | "max"
    provider: "qpay" | "bonum"
    paidAt: number
    now: number
  },
) {
  await requireBilling(db, input.workspaceID)
  const current = await db
    .select()
    .from(PlanSubscriptionTable)
    .where(
      and(
        eq(PlanSubscriptionTable.workspaceID, input.workspaceID),
        eq(PlanSubscriptionTable.status, "active"),
        isNull(PlanSubscriptionTable.timeDeleted),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])

  if (current && current.timePeriodEnd.getTime() <= input.now) {
    await db
      .update(PlanSubscriptionTable)
      .set({ status: "expired" })
      .where(and(eq(PlanSubscriptionTable.id, current.id), eq(PlanSubscriptionTable.status, "active")))
    await clearWorkspacePlan(db, current.workspaceID, current.invoiceID)
  } else if (current) {
    throw new Error("Workspace already has an active plan subscription")
  }

  const periodStart = Math.min(input.paidAt, input.now)
  const periodEnd = addUtcCalendarMonths(periodStart, DEFAULT_PERIOD_MONTHS)
  const status = periodEnd <= input.now ? ("expired" as const) : ("active" as const)
  const subscriptionID = Identifier.create("subscription")
  await db.insert(PlanSubscriptionTable).values({
    id: subscriptionID,
    workspaceID: input.workspaceID,
    invoiceID: input.invoiceID,
    plan: input.plan,
    status,
    timePeriodStart: new Date(periodStart),
    timePeriodEnd: new Date(periodEnd),
  })

  if (status === "expired") return

  await db
    .update(BillingTable)
    .set({
      subscriptionID,
      subscriptionPlan: null,
      timeSubscriptionBooked: null,
      timeSubscriptionSelected: null,
      subscription: {
        status: "subscribed",
        seats: 1,
        plan: input.plan,
        source: input.provider,
        invoiceID: input.invoiceID,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    })
    .where(eq(BillingTable.workspaceID, input.workspaceID))

  const users = await db
    .select({ id: UserTable.id })
    .from(UserTable)
    .where(and(eq(UserTable.workspaceID, input.workspaceID), isNull(UserTable.timeDeleted)))
  if (users.length === 0) throw new Error("Subscription workspace has no active users")

  await db
    .insert(SubscriptionTable)
    .values(
      users.map((user) => ({
        id: Identifier.create("subscription"),
        workspaceID: input.workspaceID,
        userID: user.id,
      })),
    )
    .onConflictDoUpdate({
      target: [SubscriptionTable.workspaceID, SubscriptionTable.userID],
      set: {
        timeDeleted: null,
        rollingUsage: null,
        fixedUsage: null,
        weeklyTokens: null,
        timeRollingUpdated: null,
        timeFixedUpdated: null,
        timeWeeklyTokensUpdated: null,
      },
    })
}

async function refundPlanSubscription(
  db: Database.TxOrDb,
  input: { workspaceID: string; invoiceID: string; refundedAt: number },
) {
  const subscription = await db
    .select()
    .from(PlanSubscriptionTable)
    .where(
      and(
        eq(PlanSubscriptionTable.workspaceID, input.workspaceID),
        eq(PlanSubscriptionTable.invoiceID, input.invoiceID),
        isNull(PlanSubscriptionTable.timeDeleted),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (!subscription) throw new Error("Paid invoice has no plan subscription")

  await db
    .update(PlanSubscriptionTable)
    .set({
      status: "refunded",
      timeRefunded: new Date(input.refundedAt),
    })
    .where(eq(PlanSubscriptionTable.id, subscription.id))

  if (subscription.status === "active") {
    await clearWorkspacePlan(db, input.workspaceID, input.invoiceID)
  }
}

async function clearWorkspacePlan(db: Database.TxOrDb, workspaceID: string, invoiceID: string) {
  const billing = await requireBilling(db, workspaceID)
  const active = await db
    .select({ id: PlanSubscriptionTable.id })
    .from(PlanSubscriptionTable)
    .where(
      and(
        eq(PlanSubscriptionTable.workspaceID, workspaceID),
        eq(PlanSubscriptionTable.status, "active"),
        isNull(PlanSubscriptionTable.timeDeleted),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (active) return

  if (
    billing.subscription?.invoiceID === invoiceID ||
    billing.subscription?.source === "qpay" ||
    billing.subscription?.source === "bonum"
  ) {
    await db
      .update(BillingTable)
      .set({ subscriptionID: null, subscription: null })
      .where(eq(BillingTable.workspaceID, workspaceID))
  }
  await db.delete(SubscriptionTable).where(eq(SubscriptionTable.workspaceID, workspaceID))
}

async function requireBilling(db: Database.TxOrDb, workspaceID: string) {
  const billing = await db
    .select({
      subscription: BillingTable.subscription,
    })
    .from(BillingTable)
    .where(eq(BillingTable.workspaceID, workspaceID))
    .limit(1)
    .then((rows) => rows[0])
  if (!billing) throw new Error("Subscription workspace has no billing record")
  return billing
}
