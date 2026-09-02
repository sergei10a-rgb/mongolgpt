import { beforeEach, describe, expect, test } from "bun:test"
import { GatewayCatalog } from "@mongolgpt/console-core/model.js"
import {
  expandUpstreamFreeModels,
  loadUpstreamFreeModels,
  parseUpstreamFreeModels,
  resetUpstreamFreeModelsCacheForTest,
  upstreamFreePolicyModelID,
} from "./upstream-free-models"

const model = (input: Record<string, unknown>) => ({
  id: String(input.id),
  name: String(input.name ?? input.id),
  status: input.status,
  cost: input.cost ?? { input: 0, output: 0 },
  limit: { context: 128_000, output: 8_192 },
  provider: input.provider,
})

describe("upstream Free Auto catalog", () => {
  beforeEach(() => resetUpstreamFreeModelsCacheForTest())

  test("discovers active zero-cost models without relying on a free suffix", () => {
    const result = parseUpstreamFreeModels({
      opencode: {
        npm: "@ai-sdk/openai-compatible",
        models: {
          pickle: model({ id: "big-pickle" }),
          muse: model({ id: "muse-free", provider: { npm: "@ai-sdk/openai" } }),
          paid: model({ id: "paid", cost: { input: 0, output: 1 } }),
          cached: model({ id: "cached", cost: { input: 0, output: 0, cache_read: 0.1 } }),
          tiered: model({ id: "tiered", cost: { input: 0, output: 0, tiers: [{ input: 1, output: 0 }] } }),
          retired: model({ id: "retired-free", status: "deprecated" }),
          experimental: model({ id: "experimental-free", status: "alpha" }),
          malformedCost: model({ id: "malformed-cost", cost: { input: 0, output: 0, cache_read: "1" } }),
          unsafeID: model({ id: "../../unsafe" }),
          duplicate: model({ id: "big-pickle" }),
        },
      },
    })

    expect(result).toEqual([
      { id: "big-pickle", name: "big-pickle", format: "oa-compat" },
      { id: "muse-free", name: "muse-free", format: "openai" },
    ])
  })

  test("shares the Free Auto policy for dynamically discovered model IDs", () => {
    const catalog = fixtureCatalog()
    const models = [{ id: "big-pickle", name: "Big Pickle", format: "oa-compat" as const }]

    expect(upstreamFreePolicyModelID("free-auto", catalog, models)).toBe("free-auto")
    expect(upstreamFreePolicyModelID("big-pickle", catalog, models)).toBe("free-auto")
    expect(upstreamFreePolicyModelID("paid-model", catalog, models)).toBe("paid-model")
  })

  test("expands Free Auto and exposes each discovered model through the authenticated gateway", () => {
    const catalog = fixtureCatalog()
    const result = expandUpstreamFreeModels(catalog, [
      { id: "big-pickle", name: "Big Pickle", format: "oa-compat" },
      { id: "muse-free", name: "Muse Free", format: "openai" },
    ])
    const freeAuto = result.models["free-auto"]
    if (!freeAuto || Array.isArray(freeAuto)) throw new Error("Free Auto model missing")

    expect(freeAuto.providers.map((route) => route.model)).toEqual(["big-pickle", "muse-free"])
    expect(freeAuto.fallbackProviders).toEqual([freeAuto.providers[1]?.id])
    expect(result.providers[freeAuto.providers[0].id]?.format).toBe("oa-compat")
    expect(result.providers[freeAuto.providers[1].id]?.format).toBe("openai")
    expect(result.providers[freeAuto.providers[0].id]?.displayName).toBe("MongolGPT Free Auto")
    expect(result.models["big-pickle"]).toMatchObject({ name: "Big Pickle", freeForAuthenticated: true })
    expect(result.models["muse-free"]).toMatchObject({ name: "Muse Free", freeForAuthenticated: true })
  })

  test("keeps a configured external fallback after adding dynamic routes", () => {
    const catalog = fixtureCatalog(true)
    const result = expandUpstreamFreeModels(catalog, [
      { id: "big-pickle", name: "Big Pickle", format: "oa-compat" },
      { id: "muse-free", name: "Muse Free", format: "openai" },
    ])
    const freeAuto = result.models["free-auto"]
    if (!freeAuto || Array.isArray(freeAuto)) throw new Error("Free Auto model missing")

    expect(freeAuto.fallbackProviders).toEqual(["nvidia"])
    expect(freeAuto.providers.at(-1)?.id).toBe("nvidia")
  })

  test("does not expand a base route backed by a billable credential", () => {
    const catalog = fixtureCatalog()
    catalog.providers.base.apiKey = "secret-key"
    const result = expandUpstreamFreeModels(catalog, [
      { id: "big-pickle", name: "Big Pickle", format: "oa-compat" },
    ])
    const freeAuto = result.models["free-auto"]
    if (!freeAuto || Array.isArray(freeAuto)) throw new Error("Free Auto model missing")

    expect(freeAuto.providers).toEqual([{ id: "base", model: "stale-free", priority: 0, weight: 1 }])
    expect(result.models["big-pickle"]).toBeUndefined()
  })

  test("caches a valid catalog and keeps the last good copy during an outage", async () => {
    let now = 1_000
    let calls = 0
    const request = async () => {
      calls++
      if (calls > 1) return new Response("unavailable", { status: 503 })
      return Response.json({
        opencode: {
          npm: "@ai-sdk/openai-compatible",
          models: { pickle: model({ id: "big-pickle" }) },
        },
      })
    }

    const first = await loadUpstreamFreeModels({ request, now: () => now })
    const cached = await loadUpstreamFreeModels({ request, now: () => now + 1_000 })
    now += 5 * 60 * 1_000 + 1
    const stale = await loadUpstreamFreeModels({ request, now: () => now })

    expect(first.map((item) => item.id)).toEqual(["big-pickle"])
    expect(cached).toEqual(first)
    expect(stale).toEqual(first)
    expect(calls).toBe(2)
  })
})

function fixtureCatalog(withFallback = false): ReturnType<typeof GatewayCatalog.list> {
  return {
    providers: {
      base: {
        displayName: "MongolGPT суурь үнэгүй чиглэл",
        api: "https://opencode.ai/zen/v1",
        apiKey: "public",
        providerKind: "mongolgpt-base-free",
        usageMode: "managed",
        productionUseApproved: false,
      },
      ...(withFallback
        ? {
            nvidia: {
              api: "https://integrate.api.nvidia.com/v1",
              apiKey: "test",
              providerKind: "nvidia-nim" as const,
              usageMode: "managed" as const,
              productionUseApproved: false,
            },
          }
        : {}),
    },
    models: {
      "free-auto": {
        name: "MongolGPT Free Auto",
        cost: { input: 0, output: 0 },
        allowAnonymous: false,
        freeForAuthenticated: true,
        rateLimit: 20,
        freeWeeklyTokenLimit: 100_000,
        freeMaxTokensPerRequest: 8_192,
        trialProvider: undefined,
        providers: [
          { id: "base", model: "stale-free", priority: 0, weight: 1 },
          ...(withFallback ? [{ id: "nvidia", model: "nvidia-model", priority: 2, weight: 1 }] : []),
        ],
        fallbackProviders: withFallback ? ["nvidia"] : undefined,
      },
    },
  }
}
