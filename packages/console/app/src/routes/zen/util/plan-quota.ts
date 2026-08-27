import type { QuotaLedgerCommand } from "@mongolgpt/console-core/quota.js"
import { planQuotaCounterKeys, planQuotaScope } from "@mongolgpt/console-core/quota.js"
import { centsToMicroCents } from "@mongolgpt/console-core/util/price.js"
import { getMonthlyBounds, getWeekBounds } from "@mongolgpt/console-core/util/date.js"
import { ledgerCommand } from "./quota-service"

type DateLike = Date | number | null | undefined

export type PlanQuotaUsage = {
  fixedUsage?: number | null
  timeFixedUpdated?: DateLike
  weeklyTokens?: number | null
  timeWeeklyTokensUpdated?: DateLike
  weeklyRequests?: number | null
  timeWeeklyRequestsUpdated?: DateLike
  monthlyCost?: number | null
  timeMonthlyCostUpdated?: DateLike
  monthlyTokens?: number | null
  timeMonthlyTokensUpdated?: DateLike
  monthlyRequests?: number | null
  timeMonthlyRequestsUpdated?: DateLike
  rollingUsage?: number | null
  timeRollingUpdated?: DateLike
}

export type PlanQuotaInput = {
  workspaceID: string
  invoiceID: string
  userID: string
  now: Date
  timePeriodStart: Date
  usage?: PlanQuotaUsage
  limits: {
    weeklyCostLimit: number
    weeklyTokenLimit: number
    weeklyRequestLimit: number
    monthlyCostLimit: number
    monthlyTokenLimit: number
    monthlyRequestLimit: number
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

const SECOND = 1_000
const MINUTE = 60

type ModelCost = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}

export function planQuotaReservationBounds(input: {
  weeklyTokenLimit: number
  monthlyTokenLimit: number
  maxTokensPerRequest?: number
  costs: Array<ModelCost | undefined>
}) {
  if (!Number.isSafeInteger(input.weeklyTokenLimit) || input.weeklyTokenLimit < 1) {
    throw new TypeError("Багцын долоо хоногийн токены хязгаар буруу байна.")
  }
  if (!Number.isSafeInteger(input.monthlyTokenLimit) || input.monthlyTokenLimit < 1) {
    throw new TypeError("Багцын сарын токены хязгаар буруу байна.")
  }
  const configured = input.maxTokensPerRequest ?? Math.min(input.weeklyTokenLimit, input.monthlyTokenLimit)
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new TypeError("Загварын хүсэлтийн токены хязгаар буруу байна.")
  }
  const tokens = Math.min(configured, input.weeklyTokenLimit, input.monthlyTokenLimit)
  const rates = input.costs.flatMap((cost) => (cost ? Object.values(cost) : []))
  if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) throw new TypeError("Загварын өртөг буруу байна.")
  const highestRate = Math.max(0, ...rates)
  const costInMicroCents = Math.max(1, centsToMicroCents(highestRate * tokens * 100))
  if (!Number.isSafeInteger(costInMicroCents)) throw new TypeError("Загварын хүсэлтийн өртгийн хязгаар буруу байна.")
  return { costInMicroCents, tokens }
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
  if (!Number.isFinite(value) || value <= 0) return 0
  const result = centsToMicroCents(value * 100)
  return Number.isSafeInteger(result) && result > 0 ? result : 0
}

function validAmount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function responseObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function validLedgerValues(value: unknown, expectedKeys: readonly string[]) {
  const object = responseObject(value)
  if (!object || Object.keys(object).length !== expectedKeys.length) return false
  return expectedKeys.every((key) => nonnegativeInteger(object[key]) !== undefined)
}

function blockedRetryAfter(
  blockedKey: unknown,
  keys: ReturnType<typeof planQuotaCounterKeys>,
  now: number,
  weekEnd: number,
  monthEnd: number,
  rollingReset: number,
) {
  if (blockedKey === keys.weeklyCost || blockedKey === keys.weeklyTokens || blockedKey === keys.weeklyRequests)
    return secondsUntil(weekEnd, now)
  if (blockedKey === keys.monthlyCost || blockedKey === keys.monthlyTokens || blockedKey === keys.monthlyRequests)
    return secondsUntil(monthEnd, now)
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
  if (!Number.isSafeInteger(now) || now < 0) return { allowed: false, retryAfter: MINUTE, deactivated: false }
  const periodStart = input.timePeriodStart.getTime()
  if (
    !Number.isSafeInteger(periodStart) ||
    periodStart < 0 ||
    periodStart > now ||
    !Number.isSafeInteger(input.limits.weeklyTokenLimit) ||
    input.limits.weeklyTokenLimit < 1 ||
    !Number.isSafeInteger(input.limits.weeklyRequestLimit) ||
    input.limits.weeklyRequestLimit < 1 ||
    !Number.isSafeInteger(input.limits.monthlyTokenLimit) ||
    input.limits.monthlyTokenLimit < 1 ||
    !Number.isSafeInteger(input.limits.monthlyRequestLimit) ||
    input.limits.monthlyRequestLimit < 1 ||
    !Number.isSafeInteger(input.limits.rollingWindow) ||
    input.limits.rollingWindow < 1 ||
    validLimit(input.limits.weeklyCostLimit) < 1 ||
    validLimit(input.limits.monthlyCostLimit) < 1 ||
    validLimit(input.limits.rollingCostLimit) < 1 ||
    nonnegativeInteger(input.reservation.costInMicroCents) === undefined ||
    nonnegativeInteger(input.reservation.tokens) === undefined
  ) {
    return { allowed: false, retryAfter: MINUTE, deactivated: false }
  }

  const week = getWeekBounds(input.now)
  const month = getMonthlyBounds(input.now, input.timePeriodStart)
  const weekStart = week.start.getTime()
  const weekEnd = week.end.getTime()
  const monthStart = month.start.getTime()
  const monthEnd = month.end.getTime()
  const rollingWindowMs = Math.max(1, input.limits.rollingWindow * 60 * 60 * 1_000)
  const existing = input.usage
  const rollingThreshold = now - rollingWindowMs
  const rollingUpdated = timestamp(existing?.timeRollingUpdated)
  const rollingReset =
    rollingUpdated !== undefined && rollingUpdated >= rollingThreshold
      ? rollingUpdated + rollingWindowMs
      : now + rollingWindowMs
  const keys = planQuotaCounterKeys(input.userID)
  const ledgerKeys = [
    keys.weeklyCost,
    keys.weeklyTokens,
    keys.weeklyRequests,
    keys.monthlyCost,
    keys.monthlyTokens,
    keys.monthlyRequests,
    keys.rollingCost,
  ] as const
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
      counterKey: keys.weeklyRequests,
      persistedUsage: usageValue(existing?.weeklyRequests, existing?.timeWeeklyRequestsUpdated, weekStart),
      amount: 1,
      limit: input.limits.weeklyRequestLimit,
      expiresAt: weekEnd,
    },
    {
      counterKey: keys.monthlyCost,
      persistedUsage: usageValue(existing?.monthlyCost, existing?.timeMonthlyCostUpdated, monthStart),
      amount: amounts.cost,
      limit: validLimit(input.limits.monthlyCostLimit),
      expiresAt: monthEnd,
    },
    {
      counterKey: keys.monthlyTokens,
      persistedUsage: usageValue(existing?.monthlyTokens, existing?.timeMonthlyTokensUpdated, monthStart),
      amount: amounts.tokens,
      limit: input.limits.monthlyTokenLimit,
      expiresAt: monthEnd,
    },
    {
      counterKey: keys.monthlyRequests,
      persistedUsage: usageValue(existing?.monthlyRequests, existing?.timeMonthlyRequestsUpdated, monthStart),
      amount: 1,
      limit: input.limits.monthlyRequestLimit,
      expiresAt: monthEnd,
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
  if (
    !parsed ||
    typeof parsed.allowed !== "boolean" ||
    (parsed.allowed && !validLedgerValues(parsed.values, ledgerKeys))
  ) {
    return { allowed: false, retryAfter: MINUTE, deactivated: false }
  }
  if (!parsed.allowed) {
    return {
      allowed: false,
      retryAfter:
        parsed.deactivated === true
          ? 0
          : blockedRetryAfter(parsed.blockedKey, keys, now, weekEnd, monthEnd, Math.max(now + SECOND, rollingReset)),
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
            { counterKey: keys.weeklyRequests, actual: 1, expiresAt: weekEnd },
            { counterKey: keys.monthlyCost, actual: settledCost, expiresAt: monthEnd },
            { counterKey: keys.monthlyTokens, actual: settledTokens, expiresAt: monthEnd },
            { counterKey: keys.monthlyRequests, actual: 1, expiresAt: monthEnd },
            {
              counterKey: keys.rollingCost,
              actual: settledCost,
              expiresAt: Math.max(now + SECOND, rollingReset),
            },
          ],
        }
        settlementState.promise = client(scope, settleCommand).then((value) => {
          const parsed = responseObject(value)
          if (parsed?.overrun === true) {
            throw new Error("Багцын хэрэглээний тооцоо урьдчилан нөөцөлсөн хэмжээнээс хэтэрлээ.")
          }
          if (!parsed || (parsed.deactivated !== true && !validLedgerValues(parsed.values, ledgerKeys))) {
            throw new Error("Багцын хэрэглээний тооцооны хариу буруу байна.")
          }
        })
        return settlementState.promise
      },
    },
  }
}
