import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { RipgrepBinary } from "@mongolgpt/core/ripgrep/binary"

const execute = (client: HttpClient.HttpClient) =>
  HttpClientRequest.get("https://example.test/ripgrep.zip").pipe(RipgrepBinary.downloadHttpClient(client).execute)

describe("Ripgrep binary download", () => {
  test("does not cache an interrupted binary resolution", async () => {
    let attempts = 0
    const cached = await Effect.runPromise(
      RipgrepBinary.cacheSuccess(
        Effect.suspend(() => {
          attempts += 1
          return attempts === 1 ? Effect.interrupt : Effect.succeed("rg")
        }),
      ),
    )

    const interrupted = await Effect.runPromiseExit(cached)
    expect(interrupted._tag).toBe("Failure")
    expect(await Effect.runPromise(cached)).toBe("rg")
    expect(await Effect.runPromise(cached)).toBe("rg")
    expect(attempts).toBe(2)
  })

  test("retries transient server responses and accepts the third attempt", async () => {
    let attempts = 0
    const client = HttpClient.make((request) => {
      attempts += 1
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: attempts < 3 ? 503 : 200 })),
      )
    })

    const response = await Effect.runPromise(execute(client))
    expect(response.status).toBe(200)
    expect(attempts).toBe(3)
  })

  test("does not retry a non-transient client response", async () => {
    let attempts = 0
    const client = HttpClient.make((request) => {
      attempts += 1
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 400 })))
    })

    await expect(Effect.runPromise(execute(client))).rejects.toBeDefined()
    expect(attempts).toBe(1)
  })
})
