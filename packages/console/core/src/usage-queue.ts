import { and, eq, sql } from "drizzle-orm"
import { Database } from "./drizzle"
import { BillingTable, UsageTable } from "./schema/billing.sql"
import { UserTable } from "./schema/user.sql"
import { UsageQueueEventSchema, type UsageQueueEvent } from "./quota"

function resultChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0
  if ("meta" in result && result.meta && typeof result.meta === "object" && "changes" in result.meta) {
    return Number(result.meta.changes ?? 0)
  }
  if ("changes" in result) return Number(result.changes ?? 0)
  return 0
}

function monthBounds(timestamp: number) {
  const date = new Date(timestamp)
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  return { start, next }
}

export async function persistUsageQueueEventWithDb(db: Database.TxOrDb, input: UsageQueueEvent) {
  const event = UsageQueueEventSchema.parse(input)
  const timeCreated = new Date(event.timeCreated)
  const month = monthBounds(event.timeCreated)
  const inserted = await db
    .insert(UsageTable)
    .values({
      id: event.id,
      workspaceID: event.workspaceID,
      timeCreated,
      timeUpdated: timeCreated,
      model: event.usage.model,
      provider: event.usage.provider,
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
      reasoningTokens: event.usage.reasoningTokens,
      cacheReadTokens: event.usage.cacheReadTokens,
      cacheWrite5mTokens: event.usage.cacheWrite5mTokens,
      cacheWrite1hTokens: event.usage.cacheWrite1hTokens,
      cost: event.usage.cost,
      inputCost: event.usage.inputCost,
      outputCost: event.usage.outputCost,
      cacheReadCost: event.usage.cacheReadCost,
      cacheWriteCost: event.usage.cacheWriteCost,
      country: event.usage.country,
      continent: event.usage.continent,
      keyID: event.usage.keyID,
      sessionID: event.usage.sessionID,
      enrichment: event.usage.enrichment,
    })
    .onConflictDoNothing()

  if (resultChanges(inserted) === 0) return "duplicate" as const

  const billing = await db
    .update(BillingTable)
    .set({
      balance: sql`${BillingTable.balance} - ${event.workspaceCost}`,
      monthlyUsage: sql`
        CASE
          WHEN ${BillingTable.timeMonthlyUsageUpdated} >= ${month.start}
            AND ${BillingTable.timeMonthlyUsageUpdated} < ${month.next}
            THEN COALESCE(${BillingTable.monthlyUsage}, 0) + ${event.workspaceCost}
          WHEN ${BillingTable.timeMonthlyUsageUpdated} IS NULL
            OR ${BillingTable.timeMonthlyUsageUpdated} < ${month.start}
            THEN ${event.workspaceCost}
          ELSE ${BillingTable.monthlyUsage}
        END
      `,
      timeMonthlyUsageUpdated: sql`
        CASE
          WHEN ${BillingTable.timeMonthlyUsageUpdated} IS NULL
            OR ${BillingTable.timeMonthlyUsageUpdated} < ${month.next}
            THEN ${event.timeCreated}
          ELSE ${BillingTable.timeMonthlyUsageUpdated}
        END
      `,
    })
    .where(eq(BillingTable.workspaceID, event.workspaceID))

  const user = await db
    .update(UserTable)
    .set({
      monthlyUsage: sql`
        CASE
          WHEN ${UserTable.timeMonthlyUsageUpdated} >= ${month.start}
            AND ${UserTable.timeMonthlyUsageUpdated} < ${month.next}
            THEN COALESCE(${UserTable.monthlyUsage}, 0) + ${event.userCost}
          WHEN ${UserTable.timeMonthlyUsageUpdated} IS NULL
            OR ${UserTable.timeMonthlyUsageUpdated} < ${month.start}
            THEN ${event.userCost}
          ELSE ${UserTable.monthlyUsage}
        END
      `,
      timeMonthlyUsageUpdated: sql`
        CASE
          WHEN ${UserTable.timeMonthlyUsageUpdated} IS NULL
            OR ${UserTable.timeMonthlyUsageUpdated} < ${month.next}
            THEN ${event.timeCreated}
          ELSE ${UserTable.timeMonthlyUsageUpdated}
        END
      `,
    })
    .where(and(eq(UserTable.workspaceID, event.workspaceID), eq(UserTable.id, event.userID)))

  if (resultChanges(billing) !== 1 || resultChanges(user) !== 1) {
    throw new Error(`Usage event ${event.id} references a missing billing or user row`)
  }
  return "inserted" as const
}

export function persistUsageQueueEvent(input: UsageQueueEvent) {
  return Database.transaction((db) => persistUsageQueueEventWithDb(db, input))
}
