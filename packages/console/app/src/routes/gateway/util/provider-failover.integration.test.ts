import { describe, expect, test } from "bun:test"
import { oaCompatHelper } from "./provider/openai-compatible"
import { fetchWith429Retry, runProviderAttempt, type ProviderFailoverRetry } from "./provider-retry"

describe("gateway provider HTTP integration", () => {
  test("retries short OpenRouter limits through the production request helper", async () => {
    const waits: number[] = []
    let requests = 0
    using upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1
        if (requests < 3) return new Response(null, { status: 429 })
        return Response.json({ ok: true })
      },
    })

    const response = await fetchWith429Retry(`http://127.0.0.1:${upstream.port}/v1/chat/completions`, {}, {
      sleep: async (delay) => {
        waits.push(delay)
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toBe(3)
    expect(waits).toEqual([500, 1_000])
  })

  test("routes an OpenRouter 429 to NVIDIA and attributes measured usage to the fallback", async () => {
    const observed: Array<{ provider: string; authorization: string | null; model: string }> = []
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
        return Response.json(
          { error: { message: "rate limited" } },
          { status: 429, headers: { "retry-after": "60" } },
        )
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
          id: "chatcmpl-fallback",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "fallback-ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        })
      },
    })

    const route = async (
      retry: ProviderFailoverRetry = { excludeProviders: [], retryCount: 0 },
    ): Promise<{ provider: string; response: Response }> => {
      const provider = retry.excludeProviders.includes("openrouter-free")
        ? "nvidia-nim-production"
        : "openrouter-free"
      const endpoint = provider === "openrouter-free" ? openrouter : nvidia
      const model = provider === "openrouter-free" ? "openrouter/free" : "nvidia/free"
      return runProviderAttempt({
        retry,
        policy: {
          maxRetries: 3,
          stickyProvider: "prefer",
          fallbackProvider: "nvidia-nim-production",
          currentProvider: provider,
        },
        request: () =>
          fetchWith429Retry(`http://127.0.0.1:${endpoint.port}/v1/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${provider === "openrouter-free" ? "openrouter-test" : "nvidia-test"}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Сайн байна уу" }] }),
          }),
        failover: route,
        complete: async (response) => ({ provider, response }),
      })
    }

    const result = await route()
    const payload = (await result.response.json()) as { usage: unknown; choices: Array<{ message: { content: string } }> }
    const helper = oaCompatHelper({ reqModel: "free-auto", providerModel: "nvidia/free" })
    const usage = helper.normalizeUsage(helper.extractUsage(payload))

    expect(result.provider).toBe("nvidia-nim-production")
    expect(payload.choices[0]?.message.content).toBe("fallback-ok")
    expect(usage).toMatchObject({ inputTokens: 11, outputTokens: 7 })
    expect(observed).toEqual([
      { provider: "openrouter-free", authorization: "Bearer openrouter-test", model: "openrouter/free" },
      { provider: "nvidia-nim-production", authorization: "Bearer nvidia-test", model: "nvidia/free" },
    ])
  })
})
