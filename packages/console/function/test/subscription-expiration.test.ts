import { describe, expect, test } from "bun:test"
import {
  runBillingExpiration,
  runPaymentCheckoutExpiration,
  runSubscriptionExpiration,
} from "../src/subscription-expiration"

describe("plan subscription expiration cron", () => {
  test("drains bounded database batches at one stable scheduled time", async () => {
    const results = [100, 100, 7]
    const calls: Array<{ now: number; limit: number }> = []
    const result = await runSubscriptionExpiration(1_783_725_600_000, async (now, limit) => {
      calls.push({ now, limit })
      return results.shift() ?? 0
    })
    expect(result).toEqual({ processed: 207, truncated: false })
    expect(calls).toEqual([
      { now: 1_783_725_600_000, limit: 100 },
      { now: 1_783_725_600_000, limit: 100 },
      { now: 1_783_725_600_000, limit: 100 },
    ])
  })

  test("rejects malformed timestamps and batch results", async () => {
    const invalidTime = await runSubscriptionExpiration(Number.NaN, async () => 0).catch((error) => error)
    const invalidBatch = await runSubscriptionExpiration(1_000, async () => 101).catch((error) => error)
    expect(invalidTime).toBeInstanceOf(TypeError)
    expect(invalidBatch).toBeInstanceOf(Error)
    if (!(invalidTime instanceof Error) || !(invalidBatch instanceof Error)) throw new Error("Expected validation errors")
    expect(invalidTime.message).toContain("time is invalid")
    expect(invalidBatch.message).toContain("batch result is invalid")
  })

  test("drains plan and checkout expiry without sharing mutable counters", async () => {
    const calls: string[] = []
    const result = await runBillingExpiration(1_783_725_600_000, {
      subscriptions: async () => {
        calls.push("subscription")
        return 0
      },
      checkouts: async () => {
        calls.push("checkout")
        return 0
      },
    })
    expect(result).toEqual({
      subscriptions: { processed: 0, truncated: false },
      checkouts: { processed: 0, truncated: false },
    })
    expect(calls).toEqual(["subscription", "checkout"])
  })

  test("labels malformed checkout batches", async () => {
    const error = await runPaymentCheckoutExpiration(1_000, async () => 101).catch((caught) => caught)
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("Expected a validation error")
    expect(error.message).toContain("Payment checkout expiration batch result is invalid")
  })
})
