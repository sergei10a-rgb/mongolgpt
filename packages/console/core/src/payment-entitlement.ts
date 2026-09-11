import { and, asc, Database, eq, exists, gt, inArray, isNull, lte, ne, notExists, or, sql, type SQL } from "./drizzle"
import { Identifier } from "./identifier"
import {
  paymentBatchGuard,
  type PaymentTransitionEffect,
  type PaymentTransitionBatchEffect,
  type PaymentBatchDatabase,
  type PaymentBatchQuery,
} from "./payment-ledger"
import { syncPaymentCheckoutStatusWithDb } from "./payment-checkout"
import { BillingTable, PaymentCheckoutTable, PlanSubscriptionTable, SubscriptionTable } from "./schema/billing.sql"
import { UserTable } from "./schema/user.sql"

const DEFAULT_PERIOD_MONTHS = 1

export function addUtcCalendarMonths(timestamp: number, months: number) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError("Захиалгын цагийн тэмдэг буруу байна")
  if (!Number.isSafeInteger(months) || months < 1 || months > 12) {
    throw new TypeError("Захиалгын хугацаа буруу байна")
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
    await syncPaymentCheckoutStatusWithDb(db, invoice.id, event.type, event.occurredAt)
    if (invoice.purpose !== "subscription") return
    if (event.type === "paid") {
      if (!invoice.plan) throw new Error("Захиалгын нэхэмжлэлд багц алга")
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

export function createPlanSubscriptionPaymentBatchEffect(
  options: { now?: () => number } = {},
): PaymentTransitionBatchEffect {
  return ({ db, invoice, event }) => {
    const now = (options.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Захиалгын цагийн тэмдэг буруу байна")
    const checkoutScope = and(eq(PaymentCheckoutTable.id, invoice.id), isNull(PaymentCheckoutTable.timeDeleted))
    const allowed =
      event.type === "refunded"
        ? (["paid"] as const)
        : event.type === "paid"
          ? (["ready", "pending", "failed", "expired", "cancelled", "paid"] as const)
          : (["ready", "pending", event.type] as const)
    const queries: PaymentBatchQuery[] = [
      paymentBatchGuard(
        db,
        or(
          notExists(db.select({ id: PaymentCheckoutTable.id }).from(PaymentCheckoutTable).where(checkoutScope)),
          exists(
            db
              .select({ id: PaymentCheckoutTable.id })
              .from(PaymentCheckoutTable)
              .where(and(checkoutScope, inArray(PaymentCheckoutTable.status, allowed))),
          ),
        ),
      ),
      db
        .update(PaymentCheckoutTable)
        .set({
          status: event.type,
          ...(event.type === "paid" ? { time_paid: new Date(event.occurredAt) } : {}),
          ...(event.type === "failed" ? { time_failed: new Date(event.occurredAt) } : {}),
          ...(event.type === "expired" ? { time_expired: new Date(event.occurredAt) } : {}),
          ...(event.type === "cancelled" ? { time_cancelled: new Date(event.occurredAt) } : {}),
          ...(event.type === "refunded" ? { time_refunded: new Date(event.occurredAt) } : {}),
        })
        .where(checkoutScope),
    ]
    if (invoice.purpose !== "subscription" || (event.type !== "paid" && event.type !== "refunded")) return queries
    const billing = db
      .select({ id: BillingTable.id })
      .from(BillingTable)
      .where(and(eq(BillingTable.workspaceID, invoice.workspace_id), isNull(BillingTable.timeDeleted)))
    queries.push(paymentBatchGuard(db, exists(billing)))
    const active = and(
      eq(PlanSubscriptionTable.workspaceID, invoice.workspace_id),
      eq(PlanSubscriptionTable.status, "active"),
      isNull(PlanSubscriptionTable.timeDeleted),
    )
    if (event.type === "refunded") {
      const refunded = and(
        eq(PlanSubscriptionTable.workspaceID, invoice.workspace_id),
        eq(PlanSubscriptionTable.invoiceID, invoice.id),
        isNull(PlanSubscriptionTable.timeDeleted),
      )
      queries.push(
        paymentBatchGuard(
          db,
          exists(db.select({ id: PlanSubscriptionTable.id }).from(PlanSubscriptionTable).where(refunded)),
        ),
        ...clearWorkspacePlanBatch(
          db,
          invoice.workspace_id,
          and(
            exists(
              db
                .select({ id: PlanSubscriptionTable.id })
                .from(PlanSubscriptionTable)
                .where(and(refunded, eq(PlanSubscriptionTable.status, "active"))),
            ),
            notExists(
              db
                .select({ id: PlanSubscriptionTable.id })
                .from(PlanSubscriptionTable)
                .where(and(active, ne(PlanSubscriptionTable.invoiceID, invoice.id))),
            ),
          ),
        ),
        db
          .update(PlanSubscriptionTable)
          .set({ status: "refunded", timeRefunded: new Date(event.occurredAt) })
          .where(refunded),
      )
      return queries
    }
    if (!invoice.plan) throw new Error("Захиалгын нэхэмжлэлд багц алга")
    const periodStart = Math.min(event.occurredAt, now)
    const periodEnd = addUtcCalendarMonths(periodStart, DEFAULT_PERIOD_MONTHS)
    const status = periodEnd <= now ? ("expired" as const) : ("active" as const)
    const subscriptionID = Identifier.create("subscription")
    const expired = and(active, lte(PlanSubscriptionTable.timePeriodEnd, new Date(now)))
    const users = and(eq(UserTable.workspaceID, invoice.workspace_id), isNull(UserTable.timeDeleted))
    queries.push(
      paymentBatchGuard(
        db,
        notExists(
          db
            .select({ id: PlanSubscriptionTable.id })
            .from(PlanSubscriptionTable)
            .where(and(active, gt(PlanSubscriptionTable.timePeriodEnd, new Date(now)))),
        ),
      ),
      ...clearWorkspacePlanBatch(
        db,
        invoice.workspace_id,
        exists(db.select({ id: PlanSubscriptionTable.id }).from(PlanSubscriptionTable).where(expired)),
      ),
      db.update(PlanSubscriptionTable).set({ status: "expired" }).where(expired),
      db.insert(PlanSubscriptionTable).values({
        id: subscriptionID,
        workspaceID: invoice.workspace_id,
        invoiceID: invoice.id,
        plan: invoice.plan,
        status,
        timePeriodStart: new Date(periodStart),
        timePeriodEnd: new Date(periodEnd),
      }),
    )
    if (status === "expired") return queries
    queries.push(
      paymentBatchGuard(db, exists(db.select({ id: UserTable.id }).from(UserTable).where(users))),
      db
        .update(BillingTable)
        .set({
          subscriptionID,
          subscriptionPlan: null,
          timeSubscriptionBooked: null,
          timeSubscriptionSelected: null,
          subscription: {
            status: "subscribed",
            seats: 1,
            plan: invoice.plan,
            source: invoice.provider,
            invoiceID: invoice.id,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        })
        .where(eq(BillingTable.workspaceID, invoice.workspace_id)),
      db
        .insert(SubscriptionTable)
        .select(
          db
            .select({
              // Generate one opaque subscription ID per selected member inside the same D1 batch.
              id: sql<string>`'sub_' || lower(hex(randomblob(13)))`.as("id"),
              workspaceID: UserTable.workspaceID,
              timeCreated: sql<Date>`${now}`.as("time_created"),
              timeUpdated: sql<Date>`${now}`.as("time_updated"),
              timeDeleted: sql<null>`null`.as("time_deleted"),
              userID: UserTable.id,
              rollingUsage: sql<null>`null`.as("rolling_usage"),
              fixedUsage: sql<null>`null`.as("fixed_usage"),
              weeklyTokens: sql<null>`null`.as("weekly_tokens"),
              weeklyRequests: sql<null>`null`.as("weekly_requests"),
              monthlyCost: sql<null>`null`.as("monthly_cost"),
              monthlyTokens: sql<null>`null`.as("monthly_tokens"),
              monthlyRequests: sql<null>`null`.as("monthly_requests"),
              timeRollingUpdated: sql<null>`null`.as("time_rolling_updated"),
              timeFixedUpdated: sql<null>`null`.as("time_fixed_updated"),
              timeWeeklyTokensUpdated: sql<null>`null`.as("time_weekly_tokens_updated"),
              timeWeeklyRequestsUpdated: sql<null>`null`.as("time_weekly_requests_updated"),
              timeMonthlyCostUpdated: sql<null>`null`.as("time_monthly_cost_updated"),
              timeMonthlyTokensUpdated: sql<null>`null`.as("time_monthly_tokens_updated"),
              timeMonthlyRequestsUpdated: sql<null>`null`.as("time_monthly_requests_updated"),
            })
            .from(UserTable)
            .where(users),
        )
        .onConflictDoUpdate({
          target: [SubscriptionTable.workspaceID, SubscriptionTable.userID],
          set: {
            timeDeleted: null,
            rollingUsage: null,
            fixedUsage: null,
            weeklyTokens: null,
            weeklyRequests: null,
            monthlyCost: null,
            monthlyTokens: null,
            monthlyRequests: null,
            timeRollingUpdated: null,
            timeFixedUpdated: null,
            timeWeeklyTokensUpdated: null,
            timeWeeklyRequestsUpdated: null,
            timeMonthlyCostUpdated: null,
            timeMonthlyTokensUpdated: null,
            timeMonthlyRequestsUpdated: null,
          },
        }),
    )
    return queries
  }
}

export const applyPlanSubscriptionPaymentBatchEffect = createPlanSubscriptionPaymentBatchEffect()

function clearWorkspacePlanBatch(
  db: PaymentBatchDatabase,
  workspaceID: string,
  condition: SQL | undefined,
): PaymentBatchQuery[] {
  if (!condition) throw new TypeError("Захиалгыг цэвэрлэх нөхцөл алга")
  const owned = db
    .select({ id: BillingTable.id })
    .from(BillingTable)
    .where(
      and(
        eq(BillingTable.workspaceID, workspaceID),
        isNull(BillingTable.timeDeleted),
        or(
          sql`json_extract(${BillingTable.subscription}, '$.source') in ('qpay', 'bonum')`,
          exists(
            db
              .select({ id: PlanSubscriptionTable.id })
              .from(PlanSubscriptionTable)
              .where(
                and(
                  eq(PlanSubscriptionTable.workspaceID, BillingTable.workspaceID),
                  eq(
                    PlanSubscriptionTable.invoiceID,
                    sql<string>`json_extract(${BillingTable.subscription}, '$.invoiceID')`,
                  ),
                  eq(PlanSubscriptionTable.status, "active"),
                  isNull(PlanSubscriptionTable.timeDeleted),
                ),
              ),
          ),
        ),
      ),
    )
  const eligible = and(condition, exists(owned))
  return [
    db.delete(SubscriptionTable).where(and(eq(SubscriptionTable.workspaceID, workspaceID), eligible)),
    db
      .update(BillingTable)
      .set({ subscriptionID: null, subscription: null })
      .where(and(eq(BillingTable.workspaceID, workspaceID), eligible)),
  ]
}

export async function expirePlanSubscriptionsWithDb(db: Database.TxOrDb, now = Date.now(), limit = 100) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Дуусах хугацааны цагийн тэмдэг буруу байна")
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    throw new TypeError("Дуусах хугацааны хязгаар буруу байна")

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

export async function expirePlanSubscriptions(
  now = Date.now(),
  limit = 100,
  dependencies: { batch?: typeof Database.batch } = {},
) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Дуусах хугацааны цагийн тэмдэг буруу байна")
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    throw new TypeError("Дуусах хугацааны хязгаар буруу байна")
  const [, , , expired] = await (dependencies.batch ?? Database.batch)((db) => {
    const eligible = db
      .select({ id: PlanSubscriptionTable.id })
      .from(PlanSubscriptionTable)
      .where(
        and(
          eq(PlanSubscriptionTable.status, "active"),
          isNull(PlanSubscriptionTable.timeDeleted),
          lte(PlanSubscriptionTable.timePeriodEnd, new Date(now)),
        ),
      )
      .orderBy(asc(PlanSubscriptionTable.timePeriodEnd), asc(PlanSubscriptionTable.id))
      .limit(limit)
    const workspaces = db
      .select({ workspaceID: PlanSubscriptionTable.workspaceID })
      .from(PlanSubscriptionTable)
      .where(inArray(PlanSubscriptionTable.id, eligible))
    const owned = db
      .select({ workspaceID: BillingTable.workspaceID })
      .from(BillingTable)
      .where(
        and(
          inArray(BillingTable.workspaceID, workspaces),
          isNull(BillingTable.timeDeleted),
          or(
            sql`json_extract(${BillingTable.subscription}, '$.source') in ('qpay', 'bonum')`,
            exists(
              db
                .select({ id: PlanSubscriptionTable.id })
                .from(PlanSubscriptionTable)
                .where(
                  and(
                    inArray(PlanSubscriptionTable.id, eligible),
                    eq(PlanSubscriptionTable.workspaceID, BillingTable.workspaceID),
                    eq(
                      PlanSubscriptionTable.invoiceID,
                      sql<string>`json_extract(${BillingTable.subscription}, '$.invoiceID')`,
                    ),
                  ),
                ),
            ),
          ),
        ),
      )
    const missing = db
      .select({ id: PlanSubscriptionTable.id })
      .from(PlanSubscriptionTable)
      .leftJoin(
        BillingTable,
        and(eq(BillingTable.workspaceID, PlanSubscriptionTable.workspaceID), isNull(BillingTable.timeDeleted)),
      )
      .where(and(inArray(PlanSubscriptionTable.id, eligible), isNull(BillingTable.id)))
    return [
      paymentBatchGuard(db, notExists(missing)),
      db.delete(SubscriptionTable).where(inArray(SubscriptionTable.workspaceID, owned)),
      db
        .update(BillingTable)
        .set({ subscriptionID: null, subscription: null })
        .where(inArray(BillingTable.workspaceID, owned)),
      db
        .update(PlanSubscriptionTable)
        .set({ status: "expired" })
        .where(inArray(PlanSubscriptionTable.id, eligible))
        .returning({ id: PlanSubscriptionTable.id }),
    ] as const
  })
  return expired.length
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
    throw new Error("Ажлын талбарт аль хэдийн идэвхтэй багцын захиалга байна")
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
  if (users.length === 0) throw new Error("Захиалгын ажлын талбарт идэвхтэй хэрэглэгч алга")

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
        weeklyRequests: null,
        monthlyCost: null,
        monthlyTokens: null,
        monthlyRequests: null,
        timeRollingUpdated: null,
        timeFixedUpdated: null,
        timeWeeklyTokensUpdated: null,
        timeWeeklyRequestsUpdated: null,
        timeMonthlyCostUpdated: null,
        timeMonthlyTokensUpdated: null,
        timeMonthlyRequestsUpdated: null,
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
  if (!subscription) throw new Error("Төлөгдсөн нэхэмжлэлд багцын захиалга алга")

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
  if (!billing) throw new Error("Захиалгын ажлын талбарт төлбөрийн бүртгэл алга")
  return billing
}
