import { describe, expect, test } from "bun:test"
import type { QuotaLedgerCommand } from "@mongolgpt/console-core/quota.js"
import { reserveFreeAutoQuota } from "./free-auto-quota"
import { runProviderAttempt, type ProviderFailoverRetry } from "./provider-retry"
import {
  resolveImmediateBillingSource,
  selectByokProviderRoute,
  selectServerProviderRoutes,
  trackAndSettleMeasuredUsage,
} from "./request-lifecycle"

function readUsage(value: unknown) {
  if (!value || typeof value !== "object" || !("usage" in value)) throw new Error("usage missing")
  const usage = value.usage
  if (
    !usage ||
    typeof usage !== "object" ||
    !("inputTokens" in usage) ||
    typeof usage.inputTokens !== "number" ||
    !("outputTokens" in usage) ||
    typeof usage.outputTokens !== "number"
  )
    throw new Error("usage invalid")
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

describe("managed request lifecycle", () => {
  test("selects only an explicitly configured BYOK route when credentials exist", () => {
    const providers = [
      { id: "openrouter", disabled: false },
      { id: "openrouter-managed", disabled: false },
      { id: "nvidia-nim", disabled: true },
    ]
    const catalogProviders = {
      openrouter: { usageMode: "byok" },
      "openrouter-managed": { usageMode: "managed" },
      "nvidia-nim": { usageMode: "byok" },
    }

    expect(
      selectByokProviderRoute({ hasCredentials: true, byokProvider: "openrouter", providers, catalogProviders }),
    ).toEqual(providers[0])
    expect(
      selectByokProviderRoute({ hasCredentials: false, byokProvider: "openrouter", providers, catalogProviders }),
    ).toBeUndefined()
    expect(
      selectByokProviderRoute({
        hasCredentials: true,
        byokProvider: "openrouter-managed",
        providers,
        catalogProviders,
      }),
    ).toBeUndefined()
    expect(
      selectByokProviderRoute({ hasCredentials: true, byokProvider: "nvidia-nim", providers, catalogProviders }),
    ).toBeUndefined()
    expect(selectServerProviderRoutes(providers, catalogProviders)).toEqual([providers[1]])
  })

  test("does not expose account-backed Free Auto to an anonymous request", () => {
    expect(
      resolveImmediateBillingSource({
        authenticated: false,
        hasProviderCredentials: false,
        freeForAuthenticated: true,
        freeWorkspace: false,
        allowAnonymous: false,
      }),
    ).toBeUndefined()
  })

  test("serves authenticated Free Auto without a plan or payment source and settles NVIDIA fallback usage", async () => {
    const source = resolveImmediateBillingSource({
      authenticated: true,
      hasProviderCredentials: false,
      freeForAuthenticated: true,
      freeWorkspace: false,
      allowAnonymous: false,
    })
    expect(source).toBe("free")

    const ledgerCalls: QuotaLedgerCommand[] = []
    const reservation = await reserveFreeAutoQuota(
      {
        accountID: "account-free",
        modelID: "free-auto",
        weekStart: new Date("2026-08-24T00:00:00.000Z"),
        persistedUsage: 10_000,
        reservation: 4_000,
        weeklyLimit: 100_000,
        ttlSeconds: 86_400,
      },
      async (_scope, command) => {
        ledgerCalls.push(command)
        return command.type === "reserve" ? { allowed: true, value: 14_000 } : { value: 10_180 }
      },
    )
    expect(reservation).toBeDefined()

    const attempts: string[] = []
    let primaryCancelled = false
    const route = async (
      retry: ProviderFailoverRetry = { excludeProviders: [], retryCount: 0 },
    ): Promise<{ provider: string; response: Response }> => {
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
          if (provider === "nvidia-nim-production") {
            return Response.json({ usage: { inputTokens: 120, outputTokens: 60 } })
          }
          return new Response(
            new ReadableStream({
              cancel() {
                primaryCancelled = true
              },
            }),
            { status: 429 },
          )
        },
        failover: route,
        complete: async (response) => ({ provider, response }),
      })
    }

    const result = await route()
    const usage = readUsage(await result.response.json())
    const tokens = usage.inputTokens + usage.outputTokens
    const tracked: Array<{ provider: string; tokens: number }> = []

    await trackAndSettleMeasuredUsage({
      actual: { costInMicroCents: 0, tokens },
      track: async () => {
        tracked.push({ provider: result.provider, tokens })
      },
      settle: async (actual) => reservation!.settle(actual.tokens),
    })

    expect(attempts).toEqual(["openrouter-free", "nvidia-nim-production"])
    expect(primaryCancelled).toBe(true)
    expect(tracked).toEqual([{ provider: "nvidia-nim-production", tokens: 180 }])
    expect(ledgerCalls).toHaveLength(2)
    expect(ledgerCalls[1]).toMatchObject({ type: "settle", actual: 180 })
  })

  test("settles measured quota even when usage persistence fails", async () => {
    const settled: number[] = []
    let failure: unknown
    try {
      await trackAndSettleMeasuredUsage({
        actual: 42,
        track: async () => {
          throw new Error("usage storage unavailable")
        },
        settle: async (actual) => {
          settled.push(actual)
        },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error ? failure.message : "").toBe("usage storage unavailable")
    expect(settled).toEqual([42])
  })
})
