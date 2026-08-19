import { describe, expect, test } from "bun:test"
import { AccountOverviewSchema, PlanNames } from "../src"

const usage = {
  scope: "workspace" as const,
  period: "week" as const,
  periodStart: 1_700_000_000_000,
  periodEnd: 1_700_604_800_000,
  requestCount: 3,
  inputTokens: 100,
  outputTokens: 50,
  reasoningTokens: 10,
  cacheReadTokens: 20,
  cacheWriteTokens: 5,
  totalTokens: 185,
  costInMicroCents: 25_000,
}

const base = {
  account: {
    id: "acc_12345",
    email: "user@mgpt.mn",
    status: "active" as const,
    createdAt: 1_700_000_000_000,
  },
  currentWorkspaceID: "wrk_12345",
}

describe("account overview public contract", () => {
  test("accepts free, paid, and unavailable quota states", () => {
    const result = AccountOverviewSchema.parse({
      ...base,
      workspaces: [
        {
          id: "wrk_12345",
          name: "Хувийн төсөл",
          slug: null,
          userID: "usr_12345",
          role: "admin",
          subscription: null,
          limits: { plan: "free", promoTokens: 0, dailyRequests: 20, dailyRequestsFallback: 5 },
          quota: { status: "model-scoped", reason: "free-auto-model-limits" },
          usage,
        },
        {
          id: "wrk_67890",
          name: "Багийн төсөл",
          slug: "team",
          userID: "usr_67890",
          role: "member",
          subscription: {
            id: "sub_12345",
            invoiceID: "inv_12345",
            plan: "pro",
            status: "active",
            periodStart: 1_700_000_000_000,
            periodEnd: 1_702_592_000_000,
          },
          limits: {
            plan: "pro",
            weeklyCostLimitInMicroCents: 100_000,
            weeklyTokenLimit: 1_000_000,
            rollingCostLimitInMicroCents: 25_000,
            rollingWindowHours: 5,
          },
          quota: {
            status: "available",
            weeklyCost: { used: 10_000, limit: 100_000, resetAt: null },
            weeklyTokens: { used: 185, limit: 1_000_000, resetAt: 1_700_604_800_000 },
            rollingCost: { used: 5_000, limit: 25_000, resetAt: null },
          },
          usage: { ...usage, period: "subscription" },
        },
        {
          id: "wrk_99999",
          name: "Түр орчин",
          slug: "staging",
          userID: "usr_99999",
          role: "admin",
          subscription: null,
          limits: { plan: "free", promoTokens: 10_000, dailyRequests: 20, dailyRequestsFallback: 5 },
          quota: { status: "unavailable", reason: "quota-service-unavailable" },
          usage,
        },
      ],
    })

    expect(result.workspaces.map((workspace) => workspace.quota.status)).toEqual([
      "model-scoped",
      "available",
      "unavailable",
    ])
    expect(PlanNames).toEqual(["basic", "pro", "max"])
  })

  test("rejects unknown fields, invalid identifiers, and unsupported plans", () => {
    expect(() => AccountOverviewSchema.parse({ ...base, workspaces: [], secret: "must-not-pass" })).toThrow()
    expect(() =>
      AccountOverviewSchema.parse({
        ...base,
        account: { ...base.account, id: "user_12345" },
        workspaces: [],
      }),
    ).toThrow()
    expect(() =>
      AccountOverviewSchema.parse({
        ...base,
        workspaces: [
          {
            id: "wrk_12345",
            name: "Төсөл",
            slug: null,
            userID: "usr_12345",
            role: "admin",
            subscription: null,
            limits: { plan: "enterprise" },
            quota: { status: "model-scoped", reason: "free-auto-model-limits" },
            usage,
          },
        ],
      }),
    ).toThrow()
  })
})
