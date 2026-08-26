import { and, eq, sql } from "drizzle-orm"
import { Database } from "./drizzle"
import { BillingTable, UsageTable } from "./schema/billing.sql"
import { UserTable } from "./schema/user.sql"
import { UsageQueueEventSchema, type UsageQueueEvent } from "./quota"
import { recordEstimatedModelCostWithDb } from "./finance-ledger"

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

  if (resultChanges(inserted) === 0) {
    const stored = await db
      .select()
      .from(UsageTable)
      .where(and(eq(UsageTable.workspaceID, event.workspaceID), eq(UsageTable.id, event.id)))
      .then((rows) => rows[0])
    if (!stored) throw new Error(`Хэрэглээний үйл явдал ${event.id}-ийн давхардлын зөрчил гарлаа`)
    assertUsageReplay(stored, event)
    await recordEstimatedModelCostWithDb(db, {
      workspaceID: event.workspaceID,
      usageID: event.id,
      provider: event.usage.provider,
      model: event.usage.model,
      costUSDInMicrocents: event.usage.cost,
      effectiveAt: event.timeCreated,
      plan: event.usage.enrichment?.plan,
    })
    return "duplicate" as const
  }

  await recordEstimatedModelCostWithDb(db, {
    workspaceID: event.workspaceID,
    usageID: event.id,
    provider: event.usage.provider,
    model: event.usage.model,
    costUSDInMicrocents: event.usage.cost,
    effectiveAt: event.timeCreated,
    plan: event.usage.enrichment?.plan,
  })

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
    throw new Error(`Хэрэглээний үйл явдал ${event.id} байхгүй төлбөр тооцоо эсвэл хэрэглэгчийн мөрийг зааж байна`)
  }
  return "inserted" as const
}

export function persistUsageQueueEvent(input: UsageQueueEvent) {
  return Database.transaction((db) => persistUsageQueueEventWithDb(db, input))
}

function assertUsageReplay(stored: typeof UsageTable.$inferSelect, replay: UsageQueueEvent) {
  const usage = replay.usage
  if (
    stored.timeCreated.getTime() !== replay.timeCreated ||
    stored.model !== usage.model ||
    stored.provider !== usage.provider ||
    stored.inputTokens !== usage.inputTokens ||
    stored.outputTokens !== usage.outputTokens ||
    stored.reasoningTokens !== (usage.reasoningTokens ?? null) ||
    stored.cacheReadTokens !== (usage.cacheReadTokens ?? null) ||
    stored.cacheWrite5mTokens !== (usage.cacheWrite5mTokens ?? null) ||
    stored.cacheWrite1hTokens !== (usage.cacheWrite1hTokens ?? null) ||
    stored.cost !== usage.cost ||
    stored.inputCost !== (usage.inputCost ?? null) ||
    stored.outputCost !== (usage.outputCost ?? null) ||
    stored.cacheReadCost !== (usage.cacheReadCost ?? null) ||
    stored.cacheWriteCost !== (usage.cacheWriteCost ?? null) ||
    stored.country !== (usage.country ?? null) ||
    stored.continent !== (usage.continent ?? null) ||
    stored.keyID !== (usage.keyID ?? null) ||
    stored.sessionID !== (usage.sessionID ?? null) ||
    stored.enrichment?.plan !== usage.enrichment?.plan
  ) {
    throw new Error(`Хэрэглээний үйл явдал ${replay.id}-ийг дахин илгээхэд хадгалсан хэрэглээтэй зөрчилдөж байна`)
  }
}
