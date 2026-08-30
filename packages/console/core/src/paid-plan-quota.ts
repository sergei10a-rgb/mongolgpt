import { planQuotaCounterKeys, planQuotaScope } from "./quota"
import { centsToMicroCents } from "./util/price"

export type PaidPlanQuotaLimits = {
  weeklyCostLimit: number
  weeklyTokenLimit: number
  weeklyRequestLimit: number
  monthlyCostLimit: number
  monthlyTokenLimit: number
  monthlyRequestLimit: number
  rollingCostLimit: number
  rollingWindow: number
}

export type ReadPlanQuota = (input: { scope: string; keys: readonly string[] }) => Promise<Record<string, number>>

export type PaidPlanQuotaUsage = {
  id: string
  userID: string
  fixedUsage: number | null
  fixedUpdated: Date | null
  weeklyTokens: number | null
  weeklyTokensUpdated: Date | null
  weeklyRequests: number | null
  weeklyRequestsUpdated: Date | null
  monthlyCost: number | null
  monthlyCostUpdated: Date | null
  monthlyTokens: number | null
  monthlyTokensUpdated: Date | null
  monthlyRequests: number | null
  monthlyRequestsUpdated: Date | null
  rollingUsage: number | null
  rollingUpdated: Date | null
}

export async function readPaidPlanQuota(
  item: PaidPlanQuotaUsage,
  invoiceID: string,
  limits: PaidPlanQuotaLimits,
  now: number,
  weekEnd: number,
  monthStart: number,
  monthEnd: number,
  read: ReadPlanQuota | undefined,
) {
  if (!read) return { status: "unavailable" as const, reason: "quota-service-unavailable" as const }
  const keys = planQuotaCounterKeys(item.userID)
  const rollingWindow = limits.rollingWindow * 3_600_000
  const weekStart = weekEnd - 7 * 24 * 3_600_000
  const rollingStart = now - rollingWindow
  try {
    const live = await read({ scope: planQuotaScope(item.id, invoiceID), keys: Object.values(keys) })
    const weeklyCost = Math.max(fresh(item.fixedUsage, item.fixedUpdated, weekStart), counter(live, keys.weeklyCost))
    const weeklyTokens = Math.max(
      fresh(item.weeklyTokens, item.weeklyTokensUpdated, weekStart),
      counter(live, keys.weeklyTokens),
    )
    const weeklyRequests = Math.max(
      fresh(item.weeklyRequests, item.weeklyRequestsUpdated, weekStart),
      counter(live, keys.weeklyRequests),
    )
    const monthlyCost = Math.max(
      fresh(item.monthlyCost, item.monthlyCostUpdated, monthStart),
      counter(live, keys.monthlyCost),
    )
    const monthlyTokens = Math.max(
      fresh(item.monthlyTokens, item.monthlyTokensUpdated, monthStart),
      counter(live, keys.monthlyTokens),
    )
    const monthlyRequests = Math.max(
      fresh(item.monthlyRequests, item.monthlyRequestsUpdated, monthStart),
      counter(live, keys.monthlyRequests),
    )
    const rollingCost = Math.max(
      fresh(item.rollingUsage, item.rollingUpdated, rollingStart),
      counter(live, keys.rollingCost),
    )
    const rollingReset =
      item.rollingUpdated && item.rollingUpdated.getTime() >= rollingStart
        ? item.rollingUpdated.getTime() + rollingWindow
        : null
    return {
      status: "available" as const,
      scope: "user" as const,
      weeklyCost: { used: weeklyCost, limit: planCostLimitInMicroCents(limits.weeklyCostLimit), resetAt: weekEnd },
      weeklyTokens: { used: weeklyTokens, limit: limits.weeklyTokenLimit, resetAt: weekEnd },
      weeklyRequests: { used: weeklyRequests, limit: limits.weeklyRequestLimit, resetAt: weekEnd },
      monthlyCost: { used: monthlyCost, limit: planCostLimitInMicroCents(limits.monthlyCostLimit), resetAt: monthEnd },
      monthlyTokens: { used: monthlyTokens, limit: limits.monthlyTokenLimit, resetAt: monthEnd },
      monthlyRequests: { used: monthlyRequests, limit: limits.monthlyRequestLimit, resetAt: monthEnd },
      rollingCost: {
        used: rollingCost,
        limit: planCostLimitInMicroCents(limits.rollingCostLimit),
        resetAt: rollingReset,
      },
    }
  } catch {
    return { status: "unavailable" as const, reason: "quota-service-unavailable" as const }
  }
}

export function planCostLimitInMicroCents(value: number) {
  return centsToMicroCents(value * 100)
}

function fresh(value: number | null, updated: Date | null, threshold: number) {
  if (!updated || updated.getTime() < threshold) return 0
  return number(value)
}

function counter(values: Record<string, number>, key: string) {
  if (!(key in values)) throw new TypeError("Хязгаарын тоолуур дутуу байна")
  return number(values[key])
}

function number(value: unknown) {
  const parsed = Number(value ?? 0)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("Usage утга буруу байна")
  return parsed
}
