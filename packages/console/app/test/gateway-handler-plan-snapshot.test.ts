import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("../src/routes/gateway/util/handler.ts", import.meta.url)).text()

describe("gateway handler plan configuration snapshot", () => {
  test("captures the runtime plan configuration once and passes it through quota paths", () => {
    expect(source.match(/await Subscription\.getLimits\(\)/g)).toHaveLength(1)
    expect(source).toContain("createTrialLimiter(modelInfo.trialProvider, ip, limits.free)")
    expect(source).toContain("createIpRateLimiter(modelInfo.id, modelInfo.rateLimit, ip, input.request, limits.free)")
    expect(source).toContain("validateBilling(authInfo, modelInfo, limits)")
    expect(source).toContain("reservePaidPlanUsage(billingSource, authInfo, modelInfo, limits)")
    expect(source).toContain("usageInfo, costInfo, limits)")
    expect(source).not.toContain("PlanData.getLimits")
    expect(source).not.toContain("LiteData.getLimits")
  })
})
