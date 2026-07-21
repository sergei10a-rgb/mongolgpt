import { and, Database, eq, gt, isNull, lte, sql } from "./drizzle"
import { Identifier } from "./identifier"
import { PlanSubscriptionTable, SubscriptionTable } from "./schema/billing.sql"
import { getWeekBounds } from "./util/date"

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
    throw new TypeError("Plan usage cost is invalid")
  }
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) throw new TypeError("Plan usage tokens are invalid")
  if (!Number.isSafeInteger(input.rollingWindowHours) || input.rollingWindowHours < 1) {
    throw new TypeError("Plan rolling window is invalid")
  }

  const entitlement = await db
    .select({ id: PlanSubscriptionTable.id })
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
