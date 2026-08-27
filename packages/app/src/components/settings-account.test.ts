import { describe, expect, test } from "bun:test"
import type { AccountOverview } from "@mongolgpt/account-contract"
import {
  accountOverviewForAccount,
  accountWorkspaceView,
  formatAccountDate,
  formatAccountNumber,
  formatAccountPercent,
} from "./settings-account"

const workspace = (input: Partial<AccountOverview["workspaces"][number]> = {}) =>
  ({
    id: "wrk_primary",
    name: "Үндсэн ажлын орчин",
    slug: "primary",
    userID: "usr_primary",
    role: "admin",
    subscription: null,
    limits: {
      plan: "free",
      promoTokens: 10_000,
      dailyRequests: 50,
      dailyRequestsFallback: 100,
    },
    quota: { status: "model-scoped", reason: "free-auto-model-limits" },
    usage: {
      scope: "workspace",
      period: "week",
      periodStart: 1_700_000_000_000,
      periodEnd: 1_700_604_800_000,
      requestCount: 12,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 190,
      costInMicroCents: 10_000,
    },
    ...input,
  }) as AccountOverview["workspaces"][number]

const overview = (workspaces: AccountOverview["workspaces"], currentWorkspaceID: string | null = "wrk_primary") =>
  ({
    account: {
      id: "acc_primary",
      email: "user@mgpt.mn",
      status: "active",
      createdAt: 1_700_000_000_000,
    },
    currentWorkspaceID,
    workspaces,
  }) satisfies AccountOverview

describe("settings account overview", () => {
  test("maps current free workspace and model-scoped quota without inventing paid limits", () => {
    const item = workspace()
    const value = accountWorkspaceView(overview([item]), item)

    expect(value.current).toBe(true)
    expect(value.plan).toBe("free")
    expect(value.limit).toEqual({ kind: "free", dailyRequests: 50, dailyRequestsFallback: 100 })
    expect(value.quota).toEqual({ kind: "model-scoped" })
    expect(value.requestCount).toBe(12)
    expect(value.totalTokens).toBe(190)
  })

  test("maps paid token limits and available quota reset", () => {
    const item = workspace({
      id: "wrk_paid",
      limits: {
        plan: "pro",
        weeklyCostLimitInMicroCents: 500_000,
        weeklyTokenLimit: 1_000_000,
        weeklyRequestLimit: 1_000,
        monthlyCostLimitInMicroCents: 2_000_000,
        monthlyTokenLimit: 4_000_000,
        monthlyRequestLimit: 4_000,
        rollingCostLimitInMicroCents: 100_000,
        rollingWindowHours: 24,
      },
      quota: {
        status: "available",
        scope: "user",
        weeklyCost: { used: 10_000, limit: 500_000, resetAt: 1_700_604_800_000 },
        weeklyTokens: { used: 125_000, limit: 1_000_000, resetAt: 1_700_604_800_000 },
        weeklyRequests: { used: 125, limit: 1_000, resetAt: 1_700_604_800_000 },
        monthlyCost: { used: 40_000, limit: 2_000_000, resetAt: 1_702_592_000_000 },
        monthlyTokens: { used: 500_000, limit: 4_000_000, resetAt: 1_702_592_000_000 },
        monthlyRequests: { used: 500, limit: 4_000, resetAt: 1_702_592_000_000 },
        rollingCost: { used: 5_000, limit: 100_000, resetAt: null },
      },
    })
    const value = accountWorkspaceView(overview([item], "wrk_primary"), item)

    expect(value.current).toBe(false)
    expect(value.plan).toBe("pro")
    expect(value.limit).toEqual({
      kind: "paid",
      weeklyTokenLimit: 1_000_000,
      weeklyRequestLimit: 1_000,
      monthlyTokenLimit: 4_000_000,
      monthlyRequestLimit: 4_000,
      rollingWindowHours: 24,
    })
    expect(value.quota).toEqual({
      kind: "available",
      weeklyCost: { used: 10_000, limit: 500_000, resetAt: 1_700_604_800_000 },
      weeklyTokens: { used: 125_000, limit: 1_000_000, resetAt: 1_700_604_800_000 },
      weeklyRequests: { used: 125, limit: 1_000, resetAt: 1_700_604_800_000 },
      monthlyCost: { used: 40_000, limit: 2_000_000, resetAt: 1_702_592_000_000 },
      monthlyTokens: { used: 500_000, limit: 4_000_000, resetAt: 1_702_592_000_000 },
      monthlyRequests: { used: 500, limit: 4_000, resetAt: 1_702_592_000_000 },
      rollingCost: { used: 5_000, limit: 100_000, resetAt: null },
    })
  })

  test("keeps unavailable quota distinct from model-scoped quota", () => {
    const item = workspace({
      quota: { status: "unavailable", reason: "quota-service-unavailable" },
    })

    expect(accountWorkspaceView(overview([item]), item).quota).toEqual({ kind: "unavailable" })
  })

  test("rejects an overview belonging to a different signed-in account", () => {
    const value = overview([workspace()])

    expect(accountOverviewForAccount("acc_primary", value)).toBe(value)
    expect(() => accountOverviewForAccount("acc_other", value)).toThrow("Аккаунтын мэдээлэл зөрүүтэй байна")
  })

  test("formats counts and rejects invalid dates without crashing settings", () => {
    expect(formatAccountNumber(1_234_567, "en-US")).toBe("1,234,567")
    expect(formatAccountPercent(25, 100, "en-US")).toBe("25%")
    expect(formatAccountDate(Number.POSITIVE_INFINITY, "en-US")).toBe("")
    expect(formatAccountDate(1_700_604_800_000, "en-US")).not.toBe("")
  })
})
