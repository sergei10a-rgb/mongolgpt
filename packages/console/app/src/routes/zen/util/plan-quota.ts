import type { QuotaLedgerCommand } from "@mongolgpt/console-core/quota.js"
import { planQuotaScope } from "@mongolgpt/console-core/quota.js"
import { centsToMicroCents } from "@mongolgpt/console-core/util/price.js"
import { ledgerCommand } from "./quota-service"

type DateLike = Date | number | null | undefined

export type PlanQuotaUsage = {
  fixedUsage?: number | null
  timeFixedUpdated?: DateLike
  weeklyTokens?: number | null
  timeWeeklyTokensUpdated?: DateLike
  rollingUsage?: number | null
  timeRollingUpdated?: DateLike
}

export type PlanQuotaInput = {
  workspaceID: string
  invoiceID: string
  userID: string
  now: Date
  existingPlanUsage?: PlanQuotaUsage
  planUsage?: PlanQuotaUsage
  existing?: PlanQuotaUsage
  limits: {
    weeklyCostLimit: number
    weeklyTokenLimit: number
    rollingCostLimit: number
    rollingWindow: number
  }
  reservation: {
    costInMicroCents: number
    tokens: number
  }
}

export type PlanQuotaDenied = {
  allowed: false
  retryAfter: number
  deactivated: boolean
}

export type PlanQuotaAllowed = {
  allowed: true
  reservation: {
    settle(actual?: { costInMicroCents: number; tokens: number }): Promise<void>
  }
}

export type PlanQuotaResult = PlanQuotaDenied | PlanQuotaAllowed
export type PlanQuotaLedgerClient = (scope: string, command: QuotaLedgerCommand) => Promise<unknown>

const WEEKLY_COST = "weekly-cost"
const WEEKLY_TOKENS = "weekly-tokens"
const ROLLING_COST = "rolling-cost"
const SECOND = 1_000
const MINUTE = 60

function counterKey(userID: string, dimension: string) {
  return `user/${userID}/${dimension}`
}

function timestamp(value: DateLike) {
  if (value instanceof Date) {
    const result = value.getTime()
    return Number.isFinite(result) ? result : undefined
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function nonnegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function nextMonday(now: Date) {
  const start = new Date(now)
  const offset = (start.getUTCDay() + 6) % 7
  start.setUTCDate(start.getUTCDate() - offset)
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() + 7)
  return start.getTime()
}

function secondsUntil(deadline: number, now: number) {
  return Math.max(1, Math.ceil((deadline - now) / SECOND))
}

function usageValue(value: number | null | undefined, updated: DateLike, threshold: number) {
  const parsed = nonnegativeInteger(value)
  const time = timestamp(updated)
  if (parsed === undefined || time === undefined || time < threshold) return 0
  return parsed
}

function validLimit(value: number) {
  return Number.isFinite(value) && value > 0 ? centsToMicroCents(value * 100) : 0
}

function validAmount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function responseObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function blockedRetryAfter(
  blockedKey: unknown,
  keys: { weeklyCost: string; weeklyTokens: string; rollingCost: string },
  now: number,
  weekEnd: number,
  rollingReset: number,
) {
  if (blockedKey === keys.weeklyCost || blockedKey === keys.weeklyTokens) return secondsUntil(weekEnd, now)
  if (blockedKey === keys.rollingCost) return secondsUntil(rollingReset, now)
  return MINUTE
}

function safeSettlementAmount(value: unknown, fallback: number) {
  return nonnegativeInteger(value) === undefined ? fallback : (value as number)
}

export async function reservePlanQuota(
  input: PlanQuotaInput,
  client: PlanQuotaLedgerClient = ledgerCommand,
): Promise<PlanQuotaResult> {
  const now = input.now.getTime()
  if (!Number.isFinite(now)) return { allowed: false, retryAfter: MINUTE, deactivated: false }

  const weekEnd = nextMonday(input.now)
  const rollingWindowMs = Math.max(1, input.limits.rollingWindow * 60 * 60 * 1_000)
  const existing = input.existingPlanUsage ?? input.planUsage ?? input.existing
  const weekStart = weekEnd - 7 * 24 * 60 * 60 * 1_000
  const rollingThreshold = now - rollingWindowMs
  const rollingUpdated = timestamp(existing?.timeRollingUpdated)
  const rollingReset =
    rollingUpdated !== undefined && rollingUpdated >= rollingThreshold
      ? rollingUpdated + rollingWindowMs
      : now + rollingWindowMs
  const keys = {
    weeklyCost: counterKey(input.userID, WEEKLY_COST),
    weeklyTokens: counterKey(input.userID, WEEKLY_TOKENS),
    rollingCost: counterKey(input.userID, ROLLING_COST),
  }
  const amounts = {
    cost: Math.max(1, validAmount(input.reservation.costInMicroCents)),
    tokens: Math.max(1, validAmount(input.reservation.tokens)),
  }
  const entries = [
    {
      counterKey: keys.weeklyCost,
      persistedUsage: usageValue(existing?.fixedUsage, existing?.timeFixedUpdated, weekStart),
      amount: amounts.cost,
      limit: validLimit(input.limits.weeklyCostLimit),
      expiresAt: weekEnd,
    },
    {
      counterKey: keys.weeklyTokens,
      persistedUsage: usageValue(existing?.weeklyTokens, existing?.timeWeeklyTokensUpdated, weekStart),
      amount: amounts.tokens,
      limit: Math.max(1, input.limits.weeklyTokenLimit),
      expiresAt: weekEnd,
    },
    {
      counterKey: keys.rollingCost,
      persistedUsage: usageValue(existing?.rollingUsage, existing?.timeRollingUpdated, rollingThreshold),
      amount: amounts.cost,
      limit: validLimit(input.limits.rollingCostLimit),
      expiresAt: Math.max(now + SECOND, rollingReset),
    },
  ] as const
  const scope = planQuotaScope(input.workspaceID, input.invoiceID)
  const reservationID = crypto.randomUUID()
  const command: QuotaLedgerCommand = {
    type: "reserve-many",
    reservationID,
    entries: [...entries],
  }

  let response: unknown
  try {
    response = await client(scope, command)
  } catch {
    return { allowed: false, retryAfter: MINUTE, deactivated: false }
  }

  const parsed = responseObject(response)
  if (!parsed || typeof parsed.allowed !== "boolean") {
    return { allowed: false, retryAfter: MINUTE, deactivated: false }
  }
  if (!parsed.allowed) {
    return {
      allowed: false,
      retryAfter:
        parsed.deactivated === true
          ? 0
          : blockedRetryAfter(parsed.blockedKey, keys, now, weekEnd, Math.max(now + SECOND, rollingReset)),
      deactivated: parsed.deactivated === true,
    }
  }

  const settlementState: { promise?: Promise<void> } = {}
  return {
    allowed: true,
    reservation: {
      settle(actual) {
        if (settlementState.promise) return settlementState.promise
        const settledCost = safeSettlementAmount(actual?.costInMicroCents, amounts.cost)
        const settledTokens = safeSettlementAmount(actual?.tokens, amounts.tokens)
        const settleCommand: QuotaLedgerCommand = {
          type: "settle-many",
          reservationID,
          entries: [
            { counterKey: keys.weeklyCost, actual: settledCost, expiresAt: weekEnd },
            { counterKey: keys.weeklyTokens, actual: settledTokens, expiresAt: weekEnd },
            {
              counterKey: keys.rollingCost,
              actual: settledCost,
              expiresAt: Math.max(now + SECOND, rollingReset),
            },
          ],
        }
        settlementState.promise = client(scope, settleCommand).then(() => undefined)
        return settlementState.promise
      },
    },
  }
}
