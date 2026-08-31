import { describe, expect, test } from "bun:test"
import { runPaymentRecovery, runPaymentRecoveryArchive } from "../src/payment-recovery"

describe("payment recovery scheduler", () => {
  test("drains a bounded R2 archive batch before database recovery", async () => {
    const result = await runPaymentRecoveryArchive(async (input) => {
      expect(input).toEqual({ limit: 50 })
      return { imported: 2, failed: 1, missing: 0, truncated: false }
    })
    expect(result).toEqual({ imported: 2, failed: 1, missing: 0, truncated: false })
  })

  test("drains bounded batches and aggregates outcomes", async () => {
    let calls = 0
    const result = await runPaymentRecovery(123, async (input) => {
      calls++
      expect(input).toEqual({ now: 123, limit: 50 })
      return calls === 1
        ? { resolved: 2, retried: 1, manualReview: 1, skipped: 0, truncated: true }
        : { resolved: 1, retried: 0, manualReview: 0, skipped: 1, truncated: false }
    })

    expect(result).toEqual({ resolved: 3, retried: 1, manualReview: 1, skipped: 1, truncated: false })
    expect(calls).toBe(2)
  })

  test("rejects invalid time and impossible batch results", async () => {
    const invalidTime = await runPaymentRecovery(Number.NaN, async () => never()).catch((error) => error)
    expect(invalidTime).toHaveProperty("message", expect.stringContaining("хугацаа буруу"))
    const invalidResult = await runPaymentRecovery(123, async () => ({
      resolved: 51,
      retried: 0,
      manualReview: 0,
      skipped: 0,
      truncated: false,
    })).catch((error) => error)
    expect(invalidResult).toHaveProperty("message", expect.stringContaining("үр дүн буруу"))
    const invalidArchive = await runPaymentRecoveryArchive(async () => ({
      imported: 51,
      failed: 0,
      missing: 0,
      truncated: false,
    })).catch((error) => error)
    expect(invalidArchive).toHaveProperty("message", expect.stringContaining("archive багцын үр дүн буруу"))
  })
})

function never(): never {
  throw new Error("should not run")
}
