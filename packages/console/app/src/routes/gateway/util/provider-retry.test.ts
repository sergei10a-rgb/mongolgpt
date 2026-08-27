import { describe, expect, test } from "bun:test"
import {
  canFailoverProvider,
  cancelProviderResponse,
  inlineProviderRetryDelayMs,
  shouldFailoverProviderStatus,
} from "./provider-retry"

describe("provider failover policy", () => {
  test("requires a bounded, non-strict route to a different fallback provider", () => {
    const input = {
      retryCount: 0,
      maxRetries: 3,
      stickyProvider: "prefer" as const,
      fallbackProvider: "fallback",
      currentProvider: "primary",
    }
    expect(canFailoverProvider(input)).toBe(true)
    expect(canFailoverProvider({ ...input, retryCount: 3 })).toBe(false)
    expect(canFailoverProvider({ ...input, stickyProvider: "strict" })).toBe(false)
    expect(canFailoverProvider({ ...input, fallbackProvider: undefined })).toBe(false)
    expect(canFailoverProvider({ ...input, currentProvider: "fallback" })).toBe(false)
  })

  test("fails over only for transient upstream statuses", () => {
    for (const status of [408, 429, 500, 502, 503, 599]) expect(shouldFailoverProviderStatus(status)).toBe(true)
    for (const status of [400, 401, 402, 403, 404, 409, 422, 600])
      expect(shouldFailoverProviderStatus(status)).toBe(false)
  })

  test("uses bounded exponential delays when Retry-After is absent or invalid", () => {
    expect(inlineProviderRetryDelayMs(null, 0)).toBe(500)
    expect(inlineProviderRetryDelayMs("invalid", 1)).toBe(1_000)
    expect(inlineProviderRetryDelayMs(null, 10)).toBe(2_000)
  })

  test("honors short Retry-After values and skips long inline waits", () => {
    const now = Date.parse("2026-07-19T00:00:00.000Z")
    expect(inlineProviderRetryDelayMs("1.25", 0, now)).toBe(1_250)
    expect(inlineProviderRetryDelayMs("Sun, 19 Jul 2026 00:00:02 GMT", 0, now)).toBe(2_000)
    expect(inlineProviderRetryDelayMs("60", 0, now)).toBeUndefined()
  })

  test("cancels an unused upstream response before failover", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { status: 503 },
    )

    await cancelProviderResponse(response)
    expect(cancelled).toBe(true)
  })
})
