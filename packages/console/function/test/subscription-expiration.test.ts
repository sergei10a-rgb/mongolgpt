import { describe, expect, test } from "bun:test"
import { runSubscriptionExpiration } from "../src/subscription-expiration"

describe("plan subscription expiration cron", () => {
  test("drains bounded database batches at one stable scheduled time", async () => {
    const results = [100, 100, 7]
    const calls: Array<{ now: number; limit: number }> = []
    await expect(
      runSubscriptionExpiration(1_783_725_600_000, async (now, limit) => {
        calls.push({ now, limit })
        return results.shift() ?? 0
      }),
    ).resolves.toEqual({ processed: 207, truncated: false })
    expect(calls).toEqual([
      { now: 1_783_725_600_000, limit: 100 },
      { now: 1_783_725_600_000, limit: 100 },
      { now: 1_783_725_600_000, limit: 100 },
    ])
  })

  test("rejects malformed timestamps and batch results", async () => {
    await expect(runSubscriptionExpiration(Number.NaN, async () => 0)).rejects.toThrow("time is invalid")
    await expect(runSubscriptionExpiration(1_000, async () => 101)).rejects.toThrow("batch result is invalid")
  })
})
