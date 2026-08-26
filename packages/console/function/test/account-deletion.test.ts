import { describe, expect, test } from "bun:test"
import { runAccountDeletionPurge, runAccountDeletionRetention } from "../src/account-deletion"

describe("account deletion retention cron", () => {
  test("drains bounded batches at one stable scheduled time", async () => {
    const calls: Array<{ now: number; limit?: number }> = []
    const results = [
      { processed: 45, failed: 3, skipped: 2, truncated: true },
      { processed: 10, failed: 0, skipped: 0, truncated: false },
    ]
    const result = await runAccountDeletionRetention(2_000_000_000_000, async (input) => {
      calls.push(input)
      return results.shift() ?? { processed: 0, failed: 0, skipped: 0, truncated: false }
    })
    expect(result).toEqual({ processed: 55, failed: 3, skipped: 2, truncated: false })
    expect(calls).toEqual([
      { now: 2_000_000_000_000, limit: 50 },
      { now: 2_000_000_000_000, limit: 50 },
    ])
  })

  test("rejects malformed timestamps and batch results", async () => {
    const invalidTime = await runAccountDeletionRetention(Number.NaN, async () => ({
      processed: 0,
      failed: 0,
      skipped: 0,
      truncated: false,
    })).catch((error) => error)
    const invalidBatch = await runAccountDeletionRetention(1_000, async () => ({
      processed: 51,
      failed: 0,
      skipped: 0,
      truncated: false,
    })).catch((error) => error)
    expect(invalidTime).toBeInstanceOf(TypeError)
    expect(invalidBatch).toBeInstanceOf(Error)
    if (!(invalidTime instanceof Error) || !(invalidBatch instanceof Error))
      throw new Error("Expected validation errors")
    expect(invalidTime.message).toContain("хугацаа буруу байна")
    expect(invalidBatch.message).toContain("багцын үр дүн буруу байна")
  })

  test("purges completed operational rows in bounded batches", async () => {
    const calls: Array<{ now: number; limit?: number }> = []
    const results = [
      { purged: 49, skipped: 1, truncated: true },
      { purged: 2, skipped: 0, truncated: false },
    ]
    const result = await runAccountDeletionPurge(2_000_000_000_000, async (input) => {
      calls.push(input)
      return results.shift() ?? { purged: 0, skipped: 0, truncated: false }
    })
    expect(result).toEqual({ purged: 51, skipped: 1, truncated: false })
    expect(calls).toEqual([
      { now: 2_000_000_000_000, limit: 50 },
      { now: 2_000_000_000_000, limit: 50 },
    ])
  })

  test("rejects malformed purge timestamps and batch results", async () => {
    const invalidTime = await runAccountDeletionPurge(Number.NaN, async () => ({
      purged: 0,
      skipped: 0,
      truncated: false,
    })).catch((error) => error)
    const invalidBatch = await runAccountDeletionPurge(1_000, async () => ({
      purged: 51,
      skipped: 0,
      truncated: false,
    })).catch((error) => error)
    expect(invalidTime).toBeInstanceOf(TypeError)
    expect(invalidBatch).toBeInstanceOf(Error)
  })
})
