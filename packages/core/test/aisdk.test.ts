import { expect } from "bun:test"
import { createServer } from "node:http"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Effect } from "effect"
import { AISDK } from "@mongolgpt/core/aisdk"
import { ModelV2 } from "@mongolgpt/core/model"
import { ProviderV2 } from "@mongolgpt/core/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(AISDK.defaultLayer)

it.live("chunk timeout preserves its error without an unhandled cancellation rejection", () =>
  Effect.gen(function* () {
    const disconnected = Promise.withResolvers<void>()
    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = createServer((_, response) => {
          response.once("close", disconnected.resolve)
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.flushHeaders()
        })
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
        return server
      }),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections()
              server.close(() => resolve())
            }),
        ),
    )
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server address missing")
    const baseURL = `http://127.0.0.1:${address.port}`
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = createOpenAICompatible({ name: "test", baseURL, ...event.options })
    })
    const language = yield* aisdk.language(
      ModelV2.Info.make({
        ...ModelV2.Info.empty(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model")),
        api: {
          id: ModelV2.ID.make("test-model"),
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: baseURL,
          settings: { chunkTimeout: 50 },
        },
      }),
    )
    const result = yield* Effect.promise(() =>
      language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
    )
    const error = yield* Effect.promise(async () => {
      try {
        for await (const part of result.stream) {
          if (part.type === "error") return part.error
        }
      } catch (error) {
        return error
      }
    })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("SSE унших хугацаа хэтэрлээ.")
    yield* Effect.promise(() => disconnected.promise)
  }),
)
