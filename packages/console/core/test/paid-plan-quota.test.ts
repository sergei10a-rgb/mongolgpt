import { describe, expect, test } from "bun:test"
import { readPaidPlanQuota } from "../src/paid-plan-quota"

const NOW = Date.UTC(2026, 7, 30, 12)
const WEEK_END = NOW + 3 * 86_400_000
const MONTH_START = NOW - 10 * 86_400_000
const MONTH_END = NOW + 20 * 86_400_000

const limits = {
  weeklyCostLimit: 2,
  weeklyTokenLimit: 100_000,
  weeklyRequestLimit: 300,
  monthlyCostLimit: 20,
  monthlyTokenLimit: 900_000,
  monthlyRequestLimit: 2_000,
  rollingCostLimit: 1,
  rollingWindow: 5,
}

const usage = {
  id: "wrk_paid_quota",
  userID: "usr_paid_quota",
  fixedUsage: 500,
  fixedUpdated: new Date(NOW - 1_000),
  weeklyTokens: 200,
  weeklyTokensUpdated: new Date(NOW - 1_000),
  weeklyRequests: 230,
  weeklyRequestsUpdated: new Date(NOW - 1_000),
  monthlyCost: 1_000,
  monthlyCostUpdated: new Date(NOW - 1_000),
  monthlyTokens: 1_500,
  monthlyTokensUpdated: new Date(NOW - 1_000),
  monthlyRequests: 1_800,
  monthlyRequestsUpdated: new Date(NOW - 1_000),
  rollingUsage: 700,
  rollingUpdated: new Date(NOW - 1_000),
}

describe("paid plan quota", () => {
  test("uses the greater persisted or live counter for every dimension", async () => {
    const quota = await readPaidPlanQuota(
      usage,
      "inv_paid_quota",
      limits,
      NOW,
      WEEK_END,
      MONTH_START,
      MONTH_END,
      async ({ scope, keys }) => {
        expect(scope).toBe("plan:wrk_paid_quota:inv_paid_quota")
        return Object.fromEntries(keys.map((key, index) => [key, [400, 250, 220, 900, 1_400, 1_900, 600][index]]))
      },
    )

    expect(quota).toMatchObject({
      status: "available",
      weeklyCost: { used: 500 },
      weeklyTokens: { used: 250 },
      weeklyRequests: { used: 230 },
      monthlyCost: { used: 1_000 },
      monthlyTokens: { used: 1_500 },
      monthlyRequests: { used: 1_900 },
      rollingCost: { used: 700 },
    })
  })

  test("returns unavailable when a required live counter is missing", async () => {
    expect(
      await readPaidPlanQuota(usage, "inv_paid_quota", limits, NOW, WEEK_END, MONTH_START, MONTH_END, async () => ({})),
    ).toEqual({ status: "unavailable", reason: "quota-service-unavailable" })
  })
})
