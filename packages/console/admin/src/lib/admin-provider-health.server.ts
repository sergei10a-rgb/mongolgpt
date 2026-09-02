import { count, Database, gte, max, sql } from "@mongolgpt/console-core/drizzle/index.js"
import { ProviderAttemptTable } from "@mongolgpt/console-core/schema/provider-health.sql.js"

const minute = 60_000
const recentWindowMs = 15 * minute
const historyWindowMs = 24 * 60 * minute
const coreProviders = ["mongolgpt-base-free", "openrouter-free", "nvidia-nim-production"] as const

export type AdminProviderHealthState = "healthy" | "warning" | "degraded" | "idle" | "unknown"

export interface AdminProviderHealthItem {
  providerID: string
  providerKind: string | null
  usageMode: "managed" | "trial"
  state: AdminProviderHealthState
  attempts15m: number
  successes15m: number
  transientFailures15m: number
  permanentErrors15m: number
  attempts24h: number
  successes24h: number
  transientFailures24h: number
  permanentErrors24h: number
  failovers24h: number
  fallbackAttempts24h: number
  averageLatencyMs24h: number
  maxLatencyMs24h: number
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastTransientFailureAt: string | null
}

export type AdminProviderHealthAggregate = {
  providerID: string
  providerKind: string | null
  usageMode: "managed" | "trial"
  attempts15m: number
  successes15m: number
  transientFailures15m: number
  permanentErrors15m: number
  attempts24h: number
  successes24h: number
  transientFailures24h: number
  permanentErrors24h: number
  failovers24h: number
  fallbackAttempts24h: number
  averageLatencyMs24h: number
  maxLatencyMs24h: number
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastTransientFailureAt: number | null
}

export async function getAdminProviderHealth(now = new Date()) {
  return Database.use((tx) => collectAdminProviderHealth(tx, now))
}

export async function collectAdminProviderHealth(tx: Database.TxOrDb, now = new Date()) {
  const historyStart = new Date(now.getTime() - historyWindowMs)
  const recentStart = new Date(now.getTime() - recentWindowMs)
  const recentStartMs = recentStart.getTime()
  const rows = await tx
    .select({
      providerID: ProviderAttemptTable.provider,
      providerKind: max(ProviderAttemptTable.provider_kind),
      usageMode: max(ProviderAttemptTable.usage_mode),
      attempts15m: sql<number>`sum(case when ${ProviderAttemptTable.time_created} >= ${recentStartMs} then 1 else 0 end)`,
      successes15m: sql<number>`sum(case when ${ProviderAttemptTable.time_created} >= ${recentStartMs} and ${ProviderAttemptTable.outcome} = 'success' then 1 else 0 end)`,
      transientFailures15m: sql<number>`sum(case when ${ProviderAttemptTable.time_created} >= ${recentStartMs} and ${ProviderAttemptTable.outcome} = 'transient-error' then 1 else 0 end)`,
      permanentErrors15m: sql<number>`sum(case when ${ProviderAttemptTable.time_created} >= ${recentStartMs} and ${ProviderAttemptTable.outcome} = 'permanent-error' then 1 else 0 end)`,
      attempts24h: count(),
      successes24h: sql<number>`sum(case when ${ProviderAttemptTable.outcome} = 'success' then 1 else 0 end)`,
      transientFailures24h: sql<number>`sum(case when ${ProviderAttemptTable.outcome} = 'transient-error' then 1 else 0 end)`,
      permanentErrors24h: sql<number>`sum(case when ${ProviderAttemptTable.outcome} = 'permanent-error' then 1 else 0 end)`,
      failovers24h: sql<number>`sum(case when ${ProviderAttemptTable.retry_count} > 0 then 1 else 0 end)`,
      fallbackAttempts24h: sql<number>`sum(case when ${ProviderAttemptTable.fallback} = 1 then 1 else 0 end)`,
      averageLatencyMs24h: sql<number>`coalesce(round(avg(${ProviderAttemptTable.latency_ms})), 0)`,
      maxLatencyMs24h: sql<number>`coalesce(max(${ProviderAttemptTable.latency_ms}), 0)`,
      lastAttemptAt: sql<number | null>`max(${ProviderAttemptTable.time_created})`,
      lastSuccessAt: sql<
        number | null
      >`max(case when ${ProviderAttemptTable.outcome} = 'success' then ${ProviderAttemptTable.time_created} end)`,
      lastTransientFailureAt: sql<
        number | null
      >`max(case when ${ProviderAttemptTable.outcome} = 'transient-error' then ${ProviderAttemptTable.time_created} end)`,
    })
    .from(ProviderAttemptTable)
    .where(gte(ProviderAttemptTable.time_created, historyStart))
    .groupBy(ProviderAttemptTable.provider)
    .limit(100)

  return summarizeAdminProviderHealth(rows as AdminProviderHealthAggregate[], now)
}

export function summarizeAdminProviderHealth(
  rows: AdminProviderHealthAggregate[],
  now = new Date(),
): AdminProviderHealthItem[] {
  const byProvider = new Map(rows.map((row) => [row.providerID, row]))
  for (const providerID of coreProviders) {
    if (rows.some((row) => row.providerID === providerID || row.providerID.startsWith(`${providerID}.`))) continue
    byProvider.set(providerID, emptyAggregate(providerID))
  }

  return [...byProvider.values()]
    .map((row) => {
      const state = providerState(row, now)
      return {
        ...row,
        state,
        lastAttemptAt: iso(row.lastAttemptAt),
        lastSuccessAt: iso(row.lastSuccessAt),
        lastTransientFailureAt: iso(row.lastTransientFailureAt),
      }
    })
    .sort(
      (left, right) =>
        stateOrder(left.state) - stateOrder(right.state) || left.providerID.localeCompare(right.providerID),
    )
}

function providerState(row: AdminProviderHealthAggregate, now: Date): AdminProviderHealthState {
  if (!row.attempts24h || row.lastAttemptAt === null) return "unknown"
  if (now.getTime() - row.lastAttemptAt > recentWindowMs) return "idle"

  const healthAttempts = row.successes15m + row.transientFailures15m
  const transientRate = healthAttempts ? row.transientFailures15m / healthAttempts : 0
  if (row.transientFailures15m >= 3 && transientRate >= 0.2) return "degraded"
  if (row.transientFailures15m > 0 || row.permanentErrors15m > 0 || row.averageLatencyMs24h >= 10_000) {
    return "warning"
  }
  return row.successes15m > 0 ? "healthy" : "unknown"
}

function emptyAggregate(providerID: string): AdminProviderHealthAggregate {
  return {
    providerID,
    providerKind: providerID.startsWith("mongolgpt-base-free")
      ? "mongolgpt-base-free"
      : providerID.startsWith("openrouter")
        ? "openrouter"
        : "nvidia-nim",
    usageMode: "managed",
    attempts15m: 0,
    successes15m: 0,
    transientFailures15m: 0,
    permanentErrors15m: 0,
    attempts24h: 0,
    successes24h: 0,
    transientFailures24h: 0,
    permanentErrors24h: 0,
    failovers24h: 0,
    fallbackAttempts24h: 0,
    averageLatencyMs24h: 0,
    maxLatencyMs24h: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastTransientFailureAt: null,
  }
}

function iso(value: number | null) {
  return value === null || !Number.isSafeInteger(value) ? null : new Date(value).toISOString()
}

function stateOrder(state: AdminProviderHealthState) {
  return { degraded: 0, warning: 1, unknown: 2, idle: 3, healthy: 4 }[state]
}
