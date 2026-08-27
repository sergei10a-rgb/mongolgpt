import { and, Database, eq, gt, isNull, lte, sql } from "./drizzle"
import { Identifier } from "./identifier"
import { PlanSubscriptionTable, SubscriptionTable } from "./schema/billing.sql"
import { getMonthlyBounds, getWeekBounds } from "./util/date"

export async function recordPlanUsageWithDb(
  db: Database.TxOrDb,
  input: {
    workspaceID: string
    userID: string
    entitlementID: string
    costInMicroCents: number
    tokens: number
    rollingWindowHours: number
    now?: Date
  },
) {
  const now = input.now ?? new Date()
  if (!Number.isSafeInteger(input.costInMicroCents) || input.costInMicroCents < 0) {
    throw new TypeError("Багцын хэрэглээний өртөг буруу байна")
  }
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 0)
    throw new TypeError("Багцын хэрэглээний токены тоо буруу байна")
  if (!Number.isSafeInteger(input.rollingWindowHours) || input.rollingWindowHours < 1) {
    throw new TypeError("Багцын гулсах хугацааны цонх буруу байна")
  }
  const entitlement = await db
    .select({ id: PlanSubscriptionTable.id, timePeriodStart: PlanSubscriptionTable.timePeriodStart })
    .from(PlanSubscriptionTable)
    .where(
      and(
        eq(PlanSubscriptionTable.id, input.entitlementID),
        eq(PlanSubscriptionTable.workspaceID, input.workspaceID),
        eq(PlanSubscriptionTable.status, "active"),
        lte(PlanSubscriptionTable.timePeriodStart, now),
        gt(PlanSubscriptionTable.timePeriodEnd, now),
        isNull(PlanSubscriptionTable.timeDeleted),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (!entitlement) return false

  const weekStartMs = getWeekBounds(now).start.getTime()
  const monthStartMs = getMonthlyBounds(now, entitlement.timePeriodStart).start.getTime()
  const nowMs = now.getTime()
  const rollingWindowMs = input.rollingWindowHours * 3_600_000
  await db
    .insert(SubscriptionTable)
    .values({
      id: Identifier.create("subscription"),
      workspaceID: input.workspaceID,
      userID: input.userID,
      fixedUsage: input.costInMicroCents,
      timeFixedUpdated: now,
      weeklyTokens: input.tokens,
      timeWeeklyTokensUpdated: now,
      weeklyRequests: 1,
      timeWeeklyRequestsUpdated: now,
      monthlyCost: input.costInMicroCents,
      timeMonthlyCostUpdated: now,
      monthlyTokens: input.tokens,
      timeMonthlyTokensUpdated: now,
      monthlyRequests: 1,
      timeMonthlyRequestsUpdated: now,
      rollingUsage: input.costInMicroCents,
      timeRollingUpdated: now,
    })
    .onConflictDoUpdate({
      target: [SubscriptionTable.workspaceID, SubscriptionTable.userID],
      set: {
        timeDeleted: null,
        fixedUsage: sql`
          CASE
            WHEN ${SubscriptionTable.timeFixedUpdated} >= ${weekStartMs}
              THEN COALESCE(${SubscriptionTable.fixedUsage}, 0) + ${input.costInMicroCents}
            ELSE ${input.costInMicroCents}
          END
        `,
        timeFixedUpdated: now,
        weeklyTokens: sql`
          CASE
            WHEN ${SubscriptionTable.timeWeeklyTokensUpdated} >= ${weekStartMs}
              THEN COALESCE(${SubscriptionTable.weeklyTokens}, 0) + ${input.tokens}
            ELSE ${input.tokens}
          END
        `,
        timeWeeklyTokensUpdated: now,
        weeklyRequests: sql`
          CASE
            WHEN ${SubscriptionTable.timeWeeklyRequestsUpdated} >= ${weekStartMs}
              THEN COALESCE(${SubscriptionTable.weeklyRequests}, 0) + 1
            ELSE 1
          END
        `,
        timeWeeklyRequestsUpdated: now,
        monthlyCost: sql`
          CASE
            WHEN ${SubscriptionTable.timeMonthlyCostUpdated} >= ${monthStartMs}
              THEN COALESCE(${SubscriptionTable.monthlyCost}, 0) + ${input.costInMicroCents}
            ELSE ${input.costInMicroCents}
          END
        `,
        timeMonthlyCostUpdated: now,
        monthlyTokens: sql`
          CASE
            WHEN ${SubscriptionTable.timeMonthlyTokensUpdated} >= ${monthStartMs}
              THEN COALESCE(${SubscriptionTable.monthlyTokens}, 0) + ${input.tokens}
            ELSE ${input.tokens}
          END
        `,
        timeMonthlyTokensUpdated: now,
        monthlyRequests: sql`
          CASE
            WHEN ${SubscriptionTable.timeMonthlyRequestsUpdated} >= ${monthStartMs}
              THEN COALESCE(${SubscriptionTable.monthlyRequests}, 0) + 1
            ELSE 1
          END
        `,
        timeMonthlyRequestsUpdated: now,
        rollingUsage: sql`
          CASE
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
  return true
}
