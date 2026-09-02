// This check runs in a child Bun process so module mocks cannot leak into the package test suite.
import { beforeEach, describe, expect, mock, test } from "bun:test"

const coreDrizzle = await import("@mongolgpt/console-core/drizzle/index.js")
const endpoints = { baseFree: "", openrouter: "", nvidia: "", byok: "" }
const authState = { credentials: null as string | null }
const state = {
  metrics: [] as Array<Record<string, unknown>>,
  usageRows: [] as Array<Record<string, unknown>>,
  providerAttempts: [] as Array<Record<string, unknown>>,
  circuit: [] as Array<{ provider: string; outcome: string }>,
}

const transactionDb = {
  insert() {
    return {
      values(value: Record<string, unknown>) {
        state.usageRows.push(value)
        return { onConflictDoNothing: async () => ({ meta: { changes: 1 } }) }
      },
    }
  },
  update() {
    return {
      set() {
        return { where: async () => ({ meta: { changes: 1 } }) }
      },
    }
  },
}

await mock.module("@mongolgpt/console-resource", () => ({
  Resource: {
    App: { stage: "dev" },
    ByokCredentialsKeyV1: { value: "unused-test-key" },
    UsageQueue: {
      send: async (value: Record<string, unknown>) => void state.providerAttempts.push(value),
    },
  },
}))

await mock.module("@mongolgpt/console-core/model.js", () => ({
  GatewayConfigurationError: class GatewayConfigurationError extends Error {},
  GatewayCatalog: {
    list: () => ({
      providers: {
        "mongolgpt-base-free": {
          api: endpoints.baseFree,
          apiKey: "public",
          format: "oa-compat",
          providerKind: "mongolgpt-base-free",
          usageMode: "managed",
        },
        "openrouter-free": {
          api: endpoints.openrouter,
          apiKey: "openrouter-upstream-test",
          format: "oa-compat",
          providerKind: "openrouter",
          usageMode: "managed",
        },
        "nvidia-nim-production": {
          api: endpoints.nvidia,
          apiKey: "nvidia-upstream-test",
          format: "oa-compat",
          providerKind: "nvidia-nim",
          usageMode: "managed",
        },
        "openrouter-byok": {
          api: endpoints.byok,
          apiKey: "byok-required",
          format: "oa-compat",
          providerKind: "openrouter",
          usageMode: "byok",
        },
      },
      models: {
        "free-auto": {
          name: "Free Auto",
          allowAnonymous: false,
          freeForAuthenticated: true,
          fallbackProviders: ["nvidia-nim-production"],
          providers: [
            { id: "mongolgpt-base-free", model: "mimo-v2.5-free", priority: 0, weight: 1 },
            { id: "openrouter-free", model: "openrouter/free", priority: 1, weight: 1 },
            { id: "nvidia-nim-production", model: "nvidia/free", priority: 2, weight: 1 },
          ],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
          },
        },
        "openrouter-byok": {
          name: "OpenRouter BYOK",
          allowAnonymous: false,
          byokProvider: "openrouter-byok",
          providers: [{ id: "openrouter-byok", model: "openrouter/byok", priority: 0, weight: 1 }],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
          },
        },
      },
    }),
  },
}))

await mock.module("@mongolgpt/console-core/subscription.js", () => ({
  Subscription: { getLimits: async () => ({ free: {}, plans: {} }) },
}))

await mock.module("@mongolgpt/console-core/finance-ledger.js", () => ({
  recordEstimatedModelCostWithDb: async () => undefined,
}))

await mock.module("@mongolgpt/console-core/drizzle/index.js", () => ({
  ...coreDrizzle,
  Database: {
    use: async () => ({
      apiKey: "key_gateway_e2e",
      accountID: "acc_gateway_e2e",
      workspaceID: "wrk_gateway_e2e",
      billing: { balance: 0 },
      user: { id: "usr_gateway_e2e" },
      planEntitlement: null,
      planUsage: null,
      provider: { credentials: authState.credentials },
      timeDisabled: null,
    }),
    transaction: async (run: (db: typeof transactionDb) => Promise<unknown>) => run(transactionDb),
  },
}))

await mock.module("./logger", () => ({
  logger: {
    metric: (value: Record<string, unknown>) => {
      state.metrics.push(value)
    },
  },
}))

await mock.module("./ipRateLimiter", () => ({
  clientIpFromRequest: () => "203.0.113.10",
  createRateLimiter: async () => undefined,
}))

await mock.module("./keyRateLimiter", () => ({ createRateLimiter: () => undefined }))
await mock.module("./trialLimiter", () => ({ createTrialLimiter: async () => undefined }))
await mock.module("./provider-circuit", () => ({
  providerCircuitKey: (provider: string) => provider,
  providerCircuit: {
    acquire: (provider: string) => ({ provider }),
    record: (permit: { provider: string }, outcome: string) => {
      state.circuit.push({ provider: permit.provider, outcome })
    },
  },
}))
await mock.module("~/lib/cli-auth", () => ({
  resolveGatewayWorkspace: async () => ({ error: "workspace_required" }),
  verifyGatewayAccount: async () => undefined,
}))

const { handler } = await import("./handler")
const { ProviderCredentials } = await import("@mongolgpt/console-core/provider-credentials.js")

beforeEach(() => {
  endpoints.baseFree = ""
  endpoints.openrouter = ""
  endpoints.nvidia = ""
  endpoints.byok = ""
  authState.credentials = null
  state.metrics.length = 0
  state.usageRows.length = 0
  state.providerAttempts.length = 0
  state.circuit.length = 0
})

describe("gateway handler HTTP boundary", () => {
  test("executes the authenticated three-route Free Auto chain and persists NVIDIA usage attribution", async () => {
    const observed: Array<{ provider: string; authorization: string | null; model: string }> = []
    using baseFree = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string }
        observed.push({
          provider: "mongolgpt-base-free",
          authorization: request.headers.get("authorization"),
          model: body.model,
        })
        return Response.json(
          { error: { message: "rate limited" } },
          { status: 429, headers: { "retry-after": "60" } },
        )
      },
    })
    using openrouter = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string }
        observed.push({
          provider: "openrouter-free",
          authorization: request.headers.get("authorization"),
          model: body.model,
        })
        return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 })
      },
    })
    using nvidia = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string }
        observed.push({
          provider: "nvidia-nim-production",
          authorization: request.headers.get("authorization"),
          model: body.model,
        })
        return Response.json({
          id: "chatcmpl-handler-fallback",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "handler-fallback-ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        })
      },
    })
    endpoints.baseFree = `http://127.0.0.1:${baseFree.port}/v1`
    endpoints.openrouter = `http://127.0.0.1:${openrouter.port}/v1`
    endpoints.nvidia = `http://127.0.0.1:${nvidia.port}/v1`

    const response = await handler(
      {
        request: new Request("https://dev.mgpt.mn/gateway/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer mongolgpt-account-token",
            "content-type": "application/json",
            "accept-language": "mn",
            "x-mongolgpt-session": "session-handler-e2e",
          },
          body: JSON.stringify({
            model: "free-auto",
            messages: [{ role: "user", content: "Сайн байна уу" }],
            stream: false,
          }),
        }),
      } as Parameters<typeof handler>[0],
      {
        format: "oa-compat",
        modelList: "full",
        parseApiKey: (headers) => headers.get("authorization")?.replace(/^Bearer /, ""),
        parseModel: (_url, body) => body.model,
        parseVariant: () => undefined,
        parseIsStream: (_url, body) => body.stream === true,
      },
    )
    const payload = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
      cost: string
    }

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(payload.choices[0]?.message.content).toBe("handler-fallback-ok")
    expect(payload.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 })
    expect(payload.cost).toBe("0")
    expect(observed).toEqual([
      {
        provider: "mongolgpt-base-free",
        authorization: "Bearer public",
        model: "mimo-v2.5-free",
      },
      {
        provider: "openrouter-free",
        authorization: "Bearer openrouter-upstream-test",
        model: "openrouter/free",
      },
      {
        provider: "nvidia-nim-production",
        authorization: "Bearer nvidia-upstream-test",
        model: "nvidia/free",
      },
    ])
    expect(JSON.stringify(observed)).not.toContain("mongolgpt-account-token")
    expect(state.circuit).toEqual([
      { provider: "mongolgpt-base-free", outcome: "transient-error" },
      { provider: "openrouter-free", outcome: "transient-error" },
      { provider: "nvidia-nim-production", outcome: "success" },
    ])
    expect(state.providerAttempts).toHaveLength(3)
    expect(state.providerAttempts).toEqual([
      expect.objectContaining({
        type: "provider-attempt",
        provider: "mongolgpt-base-free",
        outcome: "transient-error",
        responseStatus: 429,
        fallback: false,
      }),
      expect.objectContaining({
        type: "provider-attempt",
        provider: "openrouter-free",
        outcome: "transient-error",
        responseStatus: 503,
        fallback: false,
      }),
      expect.objectContaining({
        type: "provider-attempt",
        provider: "nvidia-nim-production",
        outcome: "success",
        responseStatus: 200,
        fallback: true,
      }),
    ])
    expect(state.usageRows).toHaveLength(1)
    expect(state.usageRows[0]).toMatchObject({
      workspaceID: "wrk_gateway_e2e",
      userID: "usr_gateway_e2e",
      model: "free-auto",
      provider: "nvidia-nim-production",
      inputTokens: 11,
      outputTokens: 7,
    })
    expect(
      state.metrics.filter((metric) => typeof metric.provider === "string").map((metric) => metric.provider),
    ).toEqual(["mongolgpt-base-free", "openrouter-free", "nvidia-nim-production"])
  })

  test("decrypts a workspace-bound BYOK credential for the upstream request", async () => {
    const observed: Array<{ authorization: string | null; model: string }> = []
    using upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string }
        observed.push({ authorization: request.headers.get("authorization"), model: body.model })
        return Response.json({
          id: "chatcmpl-handler-byok",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "handler-byok-ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })
      },
    })
    endpoints.byok = `http://127.0.0.1:${upstream.port}/v1`
    authState.credentials = await ProviderCredentials.encrypt({
      workspaceID: "wrk_gateway_e2e",
      provider: "openrouter-byok",
      credentials: "byok-handler-test-credential",
    })

    const response = await handler(
      {
        request: new Request("https://dev.mgpt.mn/gateway/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer mongolgpt-account-token",
            "content-type": "application/json",
            "accept-language": "mn",
          },
          body: JSON.stringify({
            model: "openrouter-byok",
            messages: [{ role: "user", content: "BYOK шалгалт" }],
            stream: false,
          }),
        }),
      } as Parameters<typeof handler>[0],
      {
        format: "oa-compat",
        modelList: "full",
        parseApiKey: (headers) => headers.get("authorization")?.replace(/^Bearer /, ""),
        parseModel: (_url, body) => body.model,
        parseVariant: () => undefined,
        parseIsStream: (_url, body) => body.stream === true,
      },
    )
    const payload = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
      cost: string
    }

    expect(response.status).toBe(200)
    expect(payload.choices[0]?.message.content).toBe("handler-byok-ok")
    expect(payload.cost).toBe("0")
    expect(observed).toEqual([{ authorization: "Bearer byok-handler-test-credential", model: "openrouter/byok" }])
    expect(JSON.stringify(observed)).not.toContain("mongolgpt-account-token")
    expect(JSON.stringify(observed)).not.toContain("mgp-byok:v1")
    expect(state.usageRows).toHaveLength(1)
    expect(state.usageRows[0]).toMatchObject({
      workspaceID: "wrk_gateway_e2e",
      userID: "usr_gateway_e2e",
      model: "openrouter-byok",
      provider: "openrouter-byok",
      inputTokens: 5,
      outputTokens: 3,
      enrichment: { plan: "byok" },
    })
    expect(state.providerAttempts).toEqual([])
  })
})
