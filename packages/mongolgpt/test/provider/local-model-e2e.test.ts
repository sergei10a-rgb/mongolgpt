import { describe, expect } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { generateText } from "ai"
import { Effect, Layer } from "effect"
import type { ConfigV1 } from "@mongolgpt/core/v1/config/config"
import { Env } from "@/env"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@mongolgpt/core/cross-spawn-spawner"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelsDev } from "@mongolgpt/core/models-dev"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@mongolgpt/core/provider"
import { ModelV2 } from "@mongolgpt/core/model"
import { provideInstanceEffect, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"

type CapturedRequest = {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly headers: Headers
}

const it = testEffect(
  Layer.mergeAll(
    Provider.defaultLayer,
    Env.defaultLayer,
    Config.defaultLayer,
    Plugin.defaultLayer,
    ModelsDev.defaultLayer,
    RuntimeFlags.defaultLayer,
    testInstanceStoreLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

async function startLocalModelServer() {
  let resolveRequest!: (value: CapturedRequest) => void
  const request = new Promise<CapturedRequest>((resolve) => {
    resolveRequest = resolve
  })

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString("utf8")
    const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}

    resolveRequest({
      path: url.pathname,
      body,
      headers: new Headers(
        Object.entries(req.headers).flatMap(([key, value]) =>
          value === undefined
            ? []
            : Array.isArray(value)
              ? [[key, value.join(", ")]]
              : [[key, value]],
        ),
      ),
    })

    if (url.pathname !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "not found" }))
      return
    }

    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: "chatcmpl-local",
        object: "chat.completion",
        created: 0,
        model: "local-llm",
        choices: [{ index: 0, message: { role: "assistant", content: "mongolgpt local ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
    )
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("temporary local model server did not bind to a TCP port")
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    request,
  }
}

describe("provider.local-model e2e", () => {
  it.effect(
    "uses the production MongolGPT provider/model path against a local OpenAI-compatible server",
    () =>
      Effect.gen(function* () {
        const local = yield* Effect.acquireRelease(
          Effect.promise(startLocalModelServer),
          ({ server }) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.close(() => resolve())
                }),
            ),
        )

        const directory = yield* tmpdirScoped({
          config: () => localProviderConfig(local.url),
        })

        const program = Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("local-llm"), ModelV2.ID.make("local-llm"))
          const language = yield* provider.getLanguage(model)

          const result = yield* Effect.promise(() =>
            generateText({
              model: language,
              prompt: "Say hello in one short sentence.",
              maxRetries: 0,
            }),
          )

          const capture = yield* Effect.promise(() => local.request)
          expect(capture.path).toBe("/v1/chat/completions")
          expect(capture.body.model).toBe("local-llm")
          expect(capture.body.stream).toBeUndefined()
          expect(capture.body.messages).toEqual([{ role: "user", content: "Say hello in one short sentence." }])
          expect(capture.headers.get("authorization")).toBe("Bearer local-test-key")
          expect(result.text).toBe("mongolgpt local ok")
          expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, totalTokens: 18 })
        })

        return yield* program.pipe(provideInstanceEffect(directory))
      }),
  )
})

function localProviderConfig(baseURL: string): Partial<ConfigV1.Info> {
  return {
    enabled_providers: ["local-llm"],
    provider: {
      "local-llm": {
        name: "Local LLM",
        npm: "@ai-sdk/openai-compatible",
        api: baseURL,
        env: [],
        models: {
          "local-llm": {
            name: "Local LLM",
            tool_call: true,
            limit: { context: 8_192, output: 2_048 },
            cost: { input: 0, output: 0 },
          },
        },
        options: { apiKey: "local-test-key" },
      },
    },
  }
}
