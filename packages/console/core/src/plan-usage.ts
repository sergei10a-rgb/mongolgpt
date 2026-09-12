import { and, Database, eq, gt, isNull, lte, sql } from "./drizzle"
import type { SQL } from "drizzle-orm"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { Identifier } from "./identifier"
import { PlanSubscriptionTable, SubscriptionTable } from "./schema/billing.sql"
import { getMonthlyBounds, getWeekBounds } from "./util/date"

export type PlanUsageInput = {
  workspaceID: string
  userID: string
  entitlementID: string
  costInMicroCents: number
  tokens: number
  rollingWindowHours: number
  now: Date
}

export function planUsageEntitlementQuery(db: Database.TxOrDb, input: PlanUsageInput) {
  if (!Number.isSafeInteger(input.costInMicroCents) || input.costInMicroCents < 0) {
    throw new TypeError("Багцын хэрэглээний өртөг буруу байна")
  }
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 0)
    throw new TypeError("Багцын хэрэглээний токены тоо буруу байна")
  if (!Number.isSafeInteger(input.rollingWindowHours) || input.rollingWindowHours < 1) {
    throw new TypeError("Багцын гулсах хугацааны цонх буруу байна")
  }
  if (!Number.isFinite(input.now.getTime())) throw new TypeError("Багцын хэрэглээний огноо буруу байна")
  return db
    .select()
    .from(PlanSubscriptionTable)
    .where(
      and(
        eq(PlanSubscriptionTable.id, input.entitlementID),
        eq(PlanSubscriptionTable.workspaceID, input.workspaceID),
        eq(PlanSubscriptionTable.status, "active"),
        lte(PlanSubscriptionTable.timePeriodStart, input.now),
        gt(PlanSubscriptionTable.timePeriodEnd, input.now),
        isNull(PlanSubscriptionTable.timeDeleted),
      ),
    )
    .limit(1)
}

export function planUsageQuery(
  db: Database.TxOrDb,
  input: PlanUsageInput,
  entitlement: typeof PlanSubscriptionTable.$inferSelect,
  condition?: SQL,
) {
  const nowMs = input.now.getTime()
  const week = getWeekBounds(input.now)
  const month = getMonthlyBounds(input.now, entitlement.timePeriodStart)
  const timestamp = sql<Date>`${nowMs}`
  const rollingWindowMs = input.rollingWindowHours * 3_600_000
  // Guard the insert as well as the update, even when this member has no projection yet.
  return db
    .insert(SubscriptionTable)
    .select(
      db
        .select({
          id: sql<string>`${Identifier.create("subscription")}`.as("id"),
          workspaceID: PlanSubscriptionTable.workspaceID,
          timeCreated: timestamp.as("time_created"),
          timeUpdated: timestamp.as("time_updated"),
          timeDeleted: sql<null>`null`.as("time_deleted"),
          userID: sql<string>`${input.userID}`.as("user_id"),
          rollingUsage: sql<number>`${input.costInMicroCents}`.as("rolling_usage"),
          fixedUsage: sql<number>`${input.costInMicroCents}`.as("fixed_usage"),
          weeklyTokens: sql<number>`${input.tokens}`.as("weekly_tokens"),
          weeklyRequests: sql<number>`1`.as("weekly_requests"),
          monthlyCost: sql<number>`${input.costInMicroCents}`.as("monthly_cost"),
          monthlyTokens: sql<number>`${input.tokens}`.as("monthly_tokens"),
          monthlyRequests: sql<number>`1`.as("monthly_requests"),
          timeRollingUpdated: timestamp.as("time_rolling_updated"),
          timeFixedUpdated: timestamp.as("time_fixed_updated"),
          timeWeeklyTokensUpdated: timestamp.as("time_weekly_tokens_updated"),
          timeWeeklyRequestsUpdated: timestamp.as("time_weekly_requests_updated"),
          timeMonthlyCostUpdated: timestamp.as("time_monthly_cost_updated"),
          timeMonthlyTokensUpdated: timestamp.as("time_monthly_tokens_updated"),
          timeMonthlyRequestsUpdated: timestamp.as("time_monthly_requests_updated"),
        })
        .from(PlanSubscriptionTable)
        .where(
          and(
            eq(PlanSubscriptionTable.id, input.entitlementID),
            eq(PlanSubscriptionTable.workspaceID, input.workspaceID),
            eq(PlanSubscriptionTable.status, "active"),
            lte(PlanSubscriptionTable.timePeriodStart, input.now),
            gt(PlanSubscriptionTable.timePeriodEnd, input.now),
            isNull(PlanSubscriptionTable.timeDeleted),
            eq(PlanSubscriptionTable.invoiceID, entitlement.invoiceID),
            eq(PlanSubscriptionTable.plan, entitlement.plan),
            eq(PlanSubscriptionTable.timePeriodStart, entitlement.timePeriodStart),
            eq(PlanSubscriptionTable.timePeriodEnd, entitlement.timePeriodEnd),
            condition,
          ),
        ),
    )
    .onConflictDoUpdate({
      target: [SubscriptionTable.workspaceID, SubscriptionTable.userID],
      set: {
        timeDeleted: null,
        fixedUsage: periodUsage(
          SubscriptionTable.fixedUsage,
          SubscriptionTable.timeFixedUpdated,
          week,
          input.costInMicroCents,
        ),
        timeFixedUpdated: latestTime(SubscriptionTable.timeFixedUpdated, nowMs),
        weeklyTokens: periodUsage(
          SubscriptionTable.weeklyTokens,
          SubscriptionTable.timeWeeklyTokensUpdated,
          week,
          input.tokens,
        ),
        timeWeeklyTokensUpdated: latestTime(SubscriptionTable.timeWeeklyTokensUpdated, nowMs),
        weeklyRequests: periodUsage(
          SubscriptionTable.weeklyRequests,
          SubscriptionTable.timeWeeklyRequestsUpdated,
          week,
          1,
        ),
        timeWeeklyRequestsUpdated: latestTime(SubscriptionTable.timeWeeklyRequestsUpdated, nowMs),
        monthlyCost: periodUsage(
          SubscriptionTable.monthlyCost,
          SubscriptionTable.timeMonthlyCostUpdated,
          month,
          input.costInMicroCents,
        ),
        timeMonthlyCostUpdated: latestTime(SubscriptionTable.timeMonthlyCostUpdated, nowMs),
        monthlyTokens: periodUsage(
          SubscriptionTable.monthlyTokens,
          SubscriptionTable.timeMonthlyTokensUpdated,
          month,
          input.tokens,
        ),
        timeMonthlyTokensUpdated: latestTime(SubscriptionTable.timeMonthlyTokensUpdated, nowMs),
        monthlyRequests: periodUsage(
          SubscriptionTable.monthlyRequests,
          SubscriptionTable.timeMonthlyRequestsUpdated,
          month,
          1,
        ),
        timeMonthlyRequestsUpdated: latestTime(SubscriptionTable.timeMonthlyRequestsUpdated, nowMs),
        rollingUsage: sql`
          CASE
            WHEN ${SubscriptionTable.timeRollingUpdated} > ${nowMs}
              THEN ${SubscriptionTable.rollingUsage}
            WHEN ${SubscriptionTable.timeRollingUpdated} >= ${nowMs - rollingWindowMs}
              THEN COALESCE(${SubscriptionTable.rollingUsage}, 0) + ${input.costInMicroCents}
            ELSE ${input.costInMicroCents}
          END
        `,
        timeRollingUpdated: sql`
          CASE
            WHEN ${SubscriptionTable.timeRollingUpdated} >= ${nowMs - rollingWindowMs}
              THEN ${SubscriptionTable.timeRollingUpdated}
            ELSE ${nowMs}
          END
        `,
      },
    })
}

function periodUsage(
  value: AnySQLiteColumn,
  updated: AnySQLiteColumn,
  bounds: { start: Date; end: Date },
  delta: number,
) {
  return sql`CASE
    WHEN ${updated} >= ${bounds.end.getTime()} THEN ${value}
    WHEN ${updated} >= ${bounds.start.getTime()} THEN COALESCE(${value}, 0) + ${delta}
    ELSE ${delta} END`
}

function latestTime(updated: AnySQLiteColumn, now: number) {
  return sql`CASE WHEN ${updated} > ${now} THEN ${updated} ELSE ${now} END`
}

export async function recordPlanUsageWithDb(db: Database.TxOrDb, input: Omit<PlanUsageInput, "now"> & { now?: Date }) {
  const parsed = { ...input, now: input.now ?? new Date() }
  const entitlement = await planUsageEntitlementQuery(db, parsed).then((rows) => rows[0])
  if (!entitlement) return false
  const result = await planUsageQuery(db, parsed, entitlement)
  return ("meta" in result ? result.meta.changes : (result as { changes: number }).changes) === 1
}
