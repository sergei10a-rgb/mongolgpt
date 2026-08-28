import { describe, expect, test } from "bun:test"
import {
  acquireProviderFailoverRoute,
  canFailoverProvider,
  cancelProviderResponse,
  inlineProviderRetryDelayMs,
  nextProviderFailoverRetry,
  partitionProviderFailoverRoutes,
  runProviderAttempt,
  shouldFailoverProviderStatus,
} from "./provider-retry"

describe("provider failover policy", () => {
  test("keeps the configured NVIDIA fallback out of the initial primary pool", () => {
    const routes = partitionProviderFailoverRoutes(
      [
        { id: "openrouter-free", priority: 0 },
        { id: "nvidia-nim-production", priority: 0 },
      ],
      "nvidia-nim-production",
    )

    expect(routes.primaryProviders.map((provider) => provider.id)).toEqual(["openrouter-free"])
    expect(routes.fallbackProviders.map((provider) => provider.id)).toEqual(["nvidia-nim-production"])
  })

  test("uses the NVIDIA fallback when every primary circuit is unavailable", () => {
    const routes = partitionProviderFailoverRoutes(
      [{ id: "openrouter-free" }, { id: "nvidia-nim-production" }],
      "nvidia-nim-production",
    )
    const attempts: string[] = []
    const selected = acquireProviderFailoverRoute({
      ...routes,
      strict: false,
      acquire: (provider) => {
        attempts.push(provider.id)
        return provider.id === "nvidia-nim-production" ? { id: "permit" } : undefined
      },
    })

    expect(attempts).toEqual(["openrouter-free", "nvidia-nim-production"])
    expect(selected?.provider.id).toBe("nvidia-nim-production")
  })

  test("fails closed instead of bypassing strict provider affinity", () => {
    const selected = acquireProviderFailoverRoute({
      primaryProviders: [{ id: "openrouter-free" }],
      fallbackProviders: [{ id: "nvidia-nim-production" }],
      strict: true,
      acquire: () => undefined,
    })

    expect(selected).toBeUndefined()
  })

  test("fails closed when the fallback circuit is also unavailable", () => {
    const selected = acquireProviderFailoverRoute({
      primaryProviders: [{ id: "openrouter-free" }],
      fallbackProviders: [{ id: "nvidia-nim-production" }],
      strict: false,
      acquire: () => undefined,
    })

    expect(selected).toBeUndefined()
  })

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

  test("moves Free Auto from OpenRouter to NVIDIA after an upstream limit", async () => {
    const attempts: string[] = []
    const route = async (retry = { excludeProviders: [] as string[], retryCount: 0 }): Promise<string> => {
      const provider = retry.excludeProviders.includes("openrouter-free") ? "nvidia-nim-production" : "openrouter-free"
      attempts.push(provider)
      return runProviderAttempt({
        retry,
        policy: {
          maxRetries: 3,
          stickyProvider: "prefer",
          fallbackProvider: "nvidia-nim-production",
          currentProvider: provider,
        },
        request: async () => new Response(null, { status: provider === "openrouter-free" ? 429 : 200 }),
        failover: route,
        complete: async (response) => `${provider}:${response.status}`,
      })
    }

    expect(await route()).toBe("nvidia-nim-production:200")
    expect(attempts).toEqual(["openrouter-free", "nvidia-nim-production"])
  })

  test("uses the NVIDIA fallback when the OpenRouter request cannot connect", async () => {
    const attempts: string[] = []
    const route = async (retry = { excludeProviders: [] as string[], retryCount: 0 }): Promise<string> => {
      const provider = retry.excludeProviders.includes("openrouter-free") ? "nvidia-nim-production" : "openrouter-free"
      attempts.push(provider)
      return runProviderAttempt({
        retry,
        policy: {
          maxRetries: 3,
          stickyProvider: "prefer",
          fallbackProvider: "nvidia-nim-production",
          currentProvider: provider,
        },
        request: async () => {
          if (provider === "openrouter-free") throw new TypeError("network unavailable")
          return new Response(null, { status: 200 })
        },
        failover: route,
        complete: async (response) => `${provider}:${response.status}`,
      })
    }

    expect(await route()).toBe("nvidia-nim-production:200")
    expect(attempts).toEqual(["openrouter-free", "nvidia-nim-production"])
  })

  test("does not hide a permanent provider rejection behind fallback", async () => {
    let failovers = 0
    const result = await runProviderAttempt({
      retry: { excludeProviders: [], retryCount: 0 },
      policy: {
        maxRetries: 3,
        stickyProvider: "prefer",
        fallbackProvider: "nvidia-nim-production",
        currentProvider: "openrouter-free",
      },
      request: async () => new Response(null, { status: 401 }),
      failover: async () => {
        failovers += 1
        return "fallback"
      },
      complete: async (response) => `openrouter-free:${response.status}`,
    })

    expect(result).toBe("openrouter-free:401")
    expect(failovers).toBe(0)
  })

  test("deduplicates excluded providers and stops at the configured fallback", () => {
    const next = nextProviderFailoverRetry({
      retry: { excludeProviders: ["openrouter-free"], retryCount: 1 },
      policy: {
        maxRetries: 3,
        stickyProvider: "prefer",
        fallbackProvider: "nvidia-nim-production",
        currentProvider: "openrouter-free",
      },
    })
    expect(next).toEqual({ excludeProviders: ["openrouter-free"], retryCount: 2 })
    expect(
      nextProviderFailoverRetry({
        retry: next!,
        policy: {
          maxRetries: 3,
          stickyProvider: "prefer",
          fallbackProvider: "nvidia-nim-production",
          currentProvider: "nvidia-nim-production",
        },
      }),
    ).toBeUndefined()
  })
})
