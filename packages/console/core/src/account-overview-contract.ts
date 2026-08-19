import { PlanNames } from "./schema/billing.sql"
import { z } from "zod"

const timestamp = z.number().int().nonnegative()
const identifier = z.string().trim().min(5).max(30)

const subscription = z
  .object({
    id: identifier.regex(/^sub_/),
    invoiceID: identifier.regex(/^inv_/),
    plan: z.enum(PlanNames),
    status: z.literal("active"),
    periodStart: timestamp,
    periodEnd: timestamp,
  })
  .strict()

const freeLimits = z
  .object({
    plan: z.literal("free"),
    promoTokens: z.number().int().nonnegative(),
    dailyRequests: z.number().int().positive(),
    dailyRequestsFallback: z.number().int().positive(),
  })
  .strict()

const paidLimits = z
  .object({
    plan: z.enum(PlanNames),
    weeklyCostLimitInMicroCents: z.number().int().positive(),
    weeklyTokenLimit: z.number().int().positive(),
    rollingCostLimitInMicroCents: z.number().int().positive(),
    rollingWindowHours: z.number().int().positive(),
  })
  .strict()

const quotaDimension = z
  .object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    resetAt: timestamp.nullable(),
  })
  .strict()

const quota = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      weeklyCost: quotaDimension,
      weeklyTokens: quotaDimension,
      rollingCost: quotaDimension,
    })
    .strict(),
  z
    .object({
      status: z.literal("model-scoped"),
      reason: z.literal("free-auto-model-limits"),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.literal("quota-service-unavailable"),
    })
    .strict(),
])

const usageSummary = z
  .object({
    scope: z.literal("workspace"),
    period: z.enum(["week", "subscription"]),
    periodStart: timestamp,
    periodEnd: timestamp,
    requestCount: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costInMicroCents: z.number().int().nonnegative(),
  })
  .strict()

export const AccountOverviewSchema = z
  .object({
    account: z
      .object({
        id: identifier.regex(/^acc_/),
        email: z.string().trim().email().max(320),
        status: z.literal("active"),
        createdAt: timestamp,
      })
      .strict(),
    currentWorkspaceID: identifier.regex(/^wrk_/).nullable(),
    workspaces: z.array(
      z
        .object({
          id: identifier.regex(/^wrk_/),
          name: z.string().trim().min(1).max(255),
          slug: z.string().trim().min(1).max(255).nullable(),
          userID: identifier.regex(/^usr_/),
          role: z.enum(["admin", "member"]),
          subscription: subscription.nullable(),
          limits: z.union([freeLimits, paidLimits]),
          quota,
          usage: usageSummary,
        })
        .strict(),
    ),
  })
  .strict()

export type AccountOverview = z.output<typeof AccountOverviewSchema>
