import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"

import {
  accountDeviceFallbackAllowed,
  accountOnboardingRequired,
  attachedManagedModelAccountReady,
  defaultConsoleUrl,
  formatAccountLabel,
  formatAccountOverview,
  formatOrgLine,
  formatPostLoginGuidance,
  managedModelAccountLoginRequired,
  normalizeAccountLoginUrl,
} from "../../src/cli/cmd/account"

describe("console account display", () => {
  test("uses the local console as the default login URL", () => {
    expect(defaultConsoleUrl).toBe("http://localhost:3000")
  })

  test("disables device-code downgrade for official hosted account services", () => {
    expect(accountDeviceFallbackAllowed("https://mgpt.mn")).toBe(false)
    expect(accountDeviceFallbackAllowed("https://dev.mgpt.mn/console")).toBe(false)
    expect(accountDeviceFallbackAllowed("https://mgpt.mn./custom-prefix")).toBe(false)
  })

  test("keeps device-code compatibility for loopback development only", () => {
    expect(accountDeviceFallbackAllowed("https://accounts.example.com")).toBe(false)
    expect(accountDeviceFallbackAllowed("http://localhost:3000")).toBe(true)
  })

  test("rejects insecure official account service URLs", () => {
    expect(() => normalizeAccountLoginUrl("http://mgpt.mn")).toThrow("HTTPS")
    expect(() => normalizeAccountLoginUrl("http://accounts.example.com/path/")).toThrow("HTTPS")
    expect(() => normalizeAccountLoginUrl("https://accounts.example.com/path/")).toThrow("албан ёсны")
    expect(normalizeAccountLoginUrl("https://mgpt.mn/console")).toBe("https://mgpt.mn")
    expect(normalizeAccountLoginUrl("http://localhost:3000/path/")).toBe("http://localhost:3000/path")
  })

  test("includes the account url in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, false))).toBe(
      "one@example.com https://one.example.com",
    )
  })

  test("includes the active marker in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, true))).toBe(
      "one@example.com https://one.example.com (идэвхтэй)",
    )
  })

  test("includes the account url in org rows", () => {
    expect(
      stripAnsi(
        formatOrgLine({ email: "one@example.com", url: "https://one.example.com" }, { id: "org-1", name: "One" }, true),
      ),
    ).toBe("  ● One  one@example.com  https://one.example.com  org-1")
  })

  test("describes default and optional model guidance after login in Mongolian", () => {
    expect(formatPostLoginGuidance()).toEqual([
      "Бүртгэлээр нэвтэрсний дараа MongolGPT Free Auto анхдагчаар идэвхжинэ.",
      "Орон нутгийн болон OpenAI-тэй нийцтэй загваруудыг хүсвэл дараа нь нэмэлтээр холбоно.",
      "NVIDIA NIM-ийг өөрийн API түлхүүрээр хувийн хөгжүүлэлт, туршилт, үнэлгээнд холбоно. Үйлдвэрлэлийн хэрэглээнд зохих NVIDIA лиценз эсвэл захиалга шаардлагатай.",
    ])
  })

  test("does not promise perpetual free access or production rights in post-login guidance", () => {
    const combined = formatPostLoginGuidance().join(" ").toLowerCase()

    expect(combined).not.toContain("үүрд")
    expect(combined).not.toContain("байнгын")
    expect(combined).not.toContain("production")
    expect(combined).not.toContain("продакшн")
  })

  test("requires account onboarding until an active workspace exists", () => {
    expect(accountOnboardingRequired(false)).toBe(true)
    expect(accountOnboardingRequired(true)).toBe(false)
  })

  test("requires login for managed-model runs, including attached servers, without blocking BYOK", () => {
    expect(managedModelAccountLoginRequired({ providerID: "mongolgpt" })).toBe(true)
    expect(managedModelAccountLoginRequired({ providerID: "mongolgpt", attached: true })).toBe(true)
    expect(managedModelAccountLoginRequired({ providerID: "openrouter" })).toBe(false)
    expect(managedModelAccountLoginRequired({ providerID: "ollama" })).toBe(false)
    expect(managedModelAccountLoginRequired({})).toBe(false)
  })

  test("accepts an attached managed model only when the remote server has an active workspace", () => {
    expect(attachedManagedModelAccountReady({ providerID: "mongolgpt" })).toBe(false)
    expect(attachedManagedModelAccountReady({ providerID: "mongolgpt", activeOrgID: "   " })).toBe(false)
    expect(attachedManagedModelAccountReady({ providerID: "mongolgpt", activeOrgID: "workspace-1" })).toBe(true)
    expect(attachedManagedModelAccountReady({ providerID: "ollama" })).toBe(true)
    expect(attachedManagedModelAccountReady({ providerID: "openrouter" })).toBe(true)
  })

  test("formats plan, quota, and usage status in Mongolian", () => {
    const lines = formatAccountOverview({
      account: {
        id: "acc_12345",
        email: "user@mgpt.mn",
        status: "active",
        createdAt: 1_700_000_000_000,
      },
      currentWorkspaceID: "wrk_12345",
      workspaces: [
        {
          id: "wrk_12345",
          name: "Миний төсөл",
          slug: null,
          userID: "usr_12345",
          role: "admin",
          subscription: null,
          limits: { plan: "free", promoTokens: 0, dailyRequests: 20, dailyRequestsFallback: 5 },
          quota: { status: "model-scoped", reason: "free-auto-model-limits" },
          usage: {
            scope: "workspace",
            period: "week",
            periodStart: 1_700_000_000_000,
            periodEnd: 1_700_604_800_000,
            requestCount: 3,
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 10,
            cacheReadTokens: 20,
            cacheWriteTokens: 5,
            totalTokens: 185,
            costInMicroCents: 0,
          },
        },
      ],
    })

    expect(lines).toEqual([
      "Бүртгэл: user@mgpt.mn",
      "● Миний төсөл · Free · админ",
      "  Ажлын орчны хэрэглээ: 3 хүсэлт, 185 токен",
      "  Өдрийн хязгаар: 20 үндсэн, 5 нөөц хүсэлт",
      "  Хэрэглээний хязгаарыг Free Auto загвар бүрээр тооцно",
    ])
    expect(lines.join(" ").toLowerCase()).not.toMatch(/workspace|quota|usage/)
  })

  test("separates workspace usage from the signed-in user's paid quota", () => {
    const resetAt = 1_700_604_800_000
    const lines = formatAccountOverview({
      account: { id: "acc_12345", email: "user@mgpt.mn", status: "active", createdAt: 1_700_000_000_000 },
      currentWorkspaceID: "wrk_12345",
      workspaces: [
        {
          id: "wrk_12345",
          name: "Багийн төсөл",
          slug: "team",
          userID: "usr_12345",
          role: "admin",
          subscription: {
            id: "sub_12345",
            invoiceID: "inv_12345",
            plan: "pro",
            status: "active",
            periodStart: 1_700_000_000_000,
            periodEnd: resetAt,
          },
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
            weeklyCost: { used: 10_000, limit: 500_000, resetAt },
            weeklyTokens: { used: 125_000, limit: 1_000_000, resetAt },
            weeklyRequests: { used: 125, limit: 1_000, resetAt },
            monthlyCost: { used: 40_000, limit: 2_000_000, resetAt },
            monthlyTokens: { used: 500_000, limit: 4_000_000, resetAt },
            monthlyRequests: { used: 500, limit: 4_000, resetAt },
            rollingCost: { used: 5_000, limit: 100_000, resetAt: null },
          },
          usage: {
            scope: "workspace",
            period: "subscription",
            periodStart: 1_700_000_000_000,
            periodEnd: resetAt,
            requestCount: 3_000,
            inputTokens: 1_000_000,
            outputTokens: 500_000,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 1_500_000,
            costInMicroCents: 100_000,
          },
        },
      ],
    })

    expect(lines).toContain("  Ажлын орчны хэрэглээ: 3,000 хүсэлт, 1,500,000 токен")
    expect(lines).toContain("  Таны 7 хоногийн хүсэлт: 125 / 1,000")
    expect(lines).toContain("  Таны сарын токен: 500,000 / 4,000,000")
  })
})
