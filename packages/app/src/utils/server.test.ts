import { describe, expect, test } from "bun:test"
import {
  authFromToken,
  authTokenFromCredentials,
  createSdkForServer,
  createServerRequest,
  isHostedServer,
} from "./server"
import { runtimeReadRetryHeader } from "@mongolgpt/runtime-auth/read-retry"

const retryScope = `v1.${"a".repeat(64)}`

describe("expired hosted admission reads", () => {
  for (const method of ["GET", "HEAD"]) {
    test(`retries ${method} once with the original scope and current browser cookies`, async () => {
      const requests: Request[] = []
      let cancelled = false
      const request = createServerRequest({
        server: { url: "https://runtime.dev.mgpt.mn" },
        fetch: async (input) => {
          requests.push(new Request(input))
          if (requests.length > 1) return Response.json({ ok: true })
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true
                return new Promise(() => {})
              },
            }),
            {
              status: 401,
              headers: { [runtimeReadRetryHeader]: retryScope },
            },
          )
        },
      })
      const result = await request("/provider?directory=project", { method })
      expect(result.status).toBe(200)
      expect(cancelled).toBe(true)
      expect(requests).toHaveLength(2)
      expect(requests[0]?.headers.get(runtimeReadRetryHeader)).toBeNull()
      expect(requests[1]?.headers.get(runtimeReadRetryHeader)).toBe(retryScope)
      expect(requests[1]?.credentials).toBe("include")
      expect(requests[1]?.url).toBe(requests[0]?.url)
      expect(requests[1]?.method).toBe(method)
    })
  }

  test("uses the same recovery for actual SDK catalog requests", async () => {
    const requests: Request[] = []
    const sdk = createSdkForServer({
      server: { url: "https://runtime.dev.mgpt.mn" },
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          requests.push(new Request(input))
          return requests.length === 1
            ? Response.json({}, { status: 401, headers: { [runtimeReadRetryHeader]: retryScope } })
            : Response.json({ all: [], default: {}, connected: [] })
        },
        { preconnect: () => {} },
      ),
      throwOnError: true,
    })
    expect((await sdk.provider.list()).data).toEqual({ all: [], default: {}, connected: [] })
    expect(requests).toHaveLength(2)
    expect(requests[1]?.headers.get(runtimeReadRetryHeader)).toBe(retryScope)
  })

  const noRetry: RequestInit[] = [
    { method: "POST", body: "mutation" },
    { method: "PATCH" },
    { method: "PUT" },
    { method: "DELETE" },
    { credentials: "omit" },
    { headers: { authorization: "Bearer expired" } },
    { headers: { [runtimeReadRetryHeader]: retryScope } },
  ]
  for (const init of noRetry) {
    test(`does not replay mutations or explicit credentials: ${JSON.stringify(init)}`, async () => {
      let calls = 0
      const request = createServerRequest({
        server: { url: "https://runtime.dev.mgpt.mn" },
        fetch: async () => {
          calls++
          return Response.json({ error: "expired" }, { status: 401, headers: { [runtimeReadRetryHeader]: retryScope } })
        },
      })
      const response = await request("/session", init)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: "expired" })
      expect(calls).toBe(1)
    })
  }

  test("does not loop if the refreshed read is still unauthorized", async () => {
    let calls = 0
    const request = createServerRequest({
      server: { url: "https://runtime.dev.mgpt.mn" },
      fetch: async () => {
        calls++
        return Response.json({}, { status: 401, headers: { [runtimeReadRetryHeader]: retryScope } })
      },
    })
    expect((await request("/provider")).status).toBe(401)
    expect(calls).toBe(2)
  })

  test("does not retry anonymous, malformed, unrelated-origin, local or aborted requests", async () => {
    for (const value of ["anonymous", "malformed", "origin", "local", "abort"]) {
      const parent = new AbortController()
      let calls = 0
      const request = createServerRequest({
        server: { url: value === "local" ? "http://127.0.0.1:4096" : "https://runtime.dev.mgpt.mn" },
        fetch: async () => {
          calls++
          if (value === "abort") parent.abort()
          return Response.json(
            {},
            {
              status: 401,
              headers:
                value === "anonymous"
                  ? {}
                  : { [runtimeReadRetryHeader]: value === "malformed" ? "v1.secret" : retryScope },
            },
          )
        },
      })
      expect(
        (
          await request(value === "origin" ? "https://other.example/provider" : "/provider", {
            signal: parent.signal,
            credentials: "include",
          })
        ).status,
      ).toBe(401)
      expect(calls).toBe(1)
    }
  })
})

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to mongolgpt", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "mongolgpt", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("mongolgpt:secret"))
  })
})

describe("hosted credentials", () => {
  test("identifies hosted and loopback servers", () => {
    expect(isHostedServer("https://runtime.dev.mgpt.mn")).toBe(true)
    expect(isHostedServer("http://127.0.0.1:4096")).toBe(false)
  })

  test("includes cookies for hosted direct requests by default", async () => {
    let request: Request | undefined
    const fetcher = async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({ ok: true })
    }

    await createServerRequest({ server: { url: "https://runtime.dev.mgpt.mn" }, fetch: fetcher })("/auth/session")
    expect(request?.credentials).toBe("include")
  })

  test("respects explicit caller credentials", async () => {
    let request: Request | undefined
    const fetcher = async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({ ok: true })
    }

    await createServerRequest({ server: { url: "https://runtime.dev.mgpt.mn" }, fetch: fetcher })("/x", {
      credentials: "omit",
    })
    expect(request?.credentials).toBe("omit")
  })

  test("includes cookies for hosted SDK requests by default", async () => {
    let request: Request | undefined
    const fetcher = (async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({ healthy: true })
    }) as typeof fetch

    const sdk = createSdkForServer({ server: { url: "https://runtime.dev.mgpt.mn" }, fetch: fetcher })
    await sdk.global.health()
    expect(request?.credentials).toBe("include")
  })
})
