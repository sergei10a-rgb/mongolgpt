import { z } from "zod"
import { fn } from "./util/fn"
import { centsToMicroCents } from "./util/price"
import { getWeekBounds, getMonthlyBounds } from "./util/date"
import { Resource } from "@mongolgpt/console-resource"

export namespace Subscription {
  const PlanLimitSchema = z.object({
    weeklyCostLimit: z.number().int().positive(),
    weeklyTokenLimit: z.number().int().positive(),
    rollingCostLimit: z.number().int().positive(),
    rollingWindow: z.number().int().positive(),
  })

  export const LimitsSchema = z.object({
    free: z.object({
      promoTokens: z.number().int().nonnegative(),
      dailyRequests: z.number().int().positive(),
      dailyRequestsFallback: z.number().int().positive(),
      checkHeaders: z.record(z.string().min(1), z.string().min(1)),
    }),
    lite: z.object({
      rollingLimit: z.number().int().positive(),
      rollingWindow: z.number().int().positive(),
      weeklyLimit: z.number().int().positive(),
      monthlyLimit: z.number().int().positive(),
    }),
    plans: z.object({
      basic: PlanLimitSchema,
      pro: PlanLimitSchema,
      max: PlanLimitSchema,
    }),
  })

  export const validate = fn(LimitsSchema, (input) => {
    return input
  })

  export const getLimits = fn(z.void(), () => {
    const json = JSON.parse(Resource.MONGOLGPT_PLAN_LIMITS.value)
    return LimitsSchema.parse(json)
  })

  export const getFreeLimits = fn(z.void(), () => {
    return getLimits()["free"]
  })

  export const analyzeRollingUsage = fn(
    z.object({
      limit: z.number().int(),
      window: z.number().int(),
      usage: z.number().int(),
      timeUpdated: z.date(),
    }),
    ({ limit, window, usage, timeUpdated }) => {
      const now = new Date()
      const rollingWindowMs = window * 3600 * 1000
      const rollingLimitInMicroCents = centsToMicroCents(limit * 100)
      const windowStart = new Date(now.getTime() - rollingWindowMs)
      if (timeUpdated < windowStart) {
        return {
          status: "ok" as const,
          resetInSec: window * 3600,
          usagePercent: 0,
        }
      }

      const windowEnd = new Date(timeUpdated.getTime() + rollingWindowMs)
      if (usage < rollingLimitInMicroCents) {
        return {
          status: "ok" as const,
          resetInSec: Math.ceil((windowEnd.getTime() - now.getTime()) / 1000),
          usagePercent: Math.floor(Math.min(100, (usage / rollingLimitInMicroCents) * 100)),
        }
      }
      return {
        status: "rate-limited" as const,
        resetInSec: Math.ceil((windowEnd.getTime() - now.getTime()) / 1000),
        usagePercent: 100,
      }
    },
  )

  export const analyzeWeeklyUsage = fn(
    z.object({
      limit: z.number().int(),
      usage: z.number().int(),
      timeUpdated: z.date(),
    }),
    ({ limit, usage, timeUpdated }) => {
      const now = new Date()
      const week = getWeekBounds(now)
      const fixedLimitInMicroCents = centsToMicroCents(limit * 100)
      if (timeUpdated < week.start) {
        return {
          status: "ok" as const,
          resetInSec: Math.ceil((week.end.getTime() - now.getTime()) / 1000),
          usagePercent: 0,
        }
      }
      if (usage < fixedLimitInMicroCents) {
        return {
          status: "ok" as const,
          resetInSec: Math.ceil((week.end.getTime() - now.getTime()) / 1000),
          usagePercent: Math.floor(Math.min(100, (usage / fixedLimitInMicroCents) * 100)),
        }
      }

      return {
        status: "rate-limited" as const,
        resetInSec: Math.ceil((week.end.getTime() - now.getTime()) / 1000),
        usagePercent: 100,
      }
    },
  )

  export const analyzeWeeklyTokens = fn(
    z.object({
      limit: z.number().int().positive(),
      usage: z.number().int().nonnegative(),
      timeUpdated: z.date(),
    }),
    ({ limit, usage, timeUpdated }) => {
      const now = new Date()
      const week = getWeekBounds(now)
      if (timeUpdated < week.start) {
        return {
          status: "ok" as const,
          resetInSec: Math.ceil((week.end.getTime() - now.getTime()) / 1000),
          usagePercent: 0,
        }
      }
      if (usage < limit) {
        return {
          status: "ok" as const,
          resetInSec: Math.ceil((week.end.getTime() - now.getTime()) / 1000),
          usagePercent: Math.floor(Math.min(100, (usage / limit) * 100)),
        }
      }
      return {
        status: "rate-limited" as const,
        resetInSec: Math.ceil((week.end.getTime() - now.getTime()) / 1000),
        usagePercent: 100,
      }
    },
  )

  export const analyzeMonthlyUsage = fn(
    z.object({
      limit: z.number().int(),
      usage: z.number().int(),
      timeUpdated: z.date(),
      timeSubscribed: z.date(),
    }),
    ({ limit, usage, timeUpdated, timeSubscribed }) => {
      const now = new Date()
      const month = getMonthlyBounds(now, timeSubscribed)
      const fixedLimitInMicroCents = centsToMicroCents(limit * 100)
      if (timeUpdated < month.start) {
        return {
          status: "ok" as const,
          resetInSec: Math.ceil((month.end.getTime() - now.getTime()) / 1000),
          usagePercent: 0,
        }
      }
      if (usage < fixedLimitInMicroCents) {
        return {
          status: "ok" as const,
          resetInSec: Math.ceil((month.end.getTime() - now.getTime()) / 1000),
          usagePercent: Math.floor(Math.min(100, (usage / fixedLimitInMicroCents) * 100)),
        }
      }

      return {
        status: "rate-limited" as const,
        resetInSec: Math.ceil((month.end.getTime() - now.getTime()) / 1000),
        usagePercent: 100,
      }
    },
  )
}
