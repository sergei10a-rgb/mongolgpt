import { describe, expect, test } from "bun:test"
import { refreshCliToken } from "./token-handler"

const endpoint = "https://auth.dev.mgpt.mn/token"

function request(value: unknown, contentType = "application/json") {
  return new Request("https://dev.mgpt.mn/auth/device/token", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(value),
  })
}

const body = (overrides: Record<string, unknown> = {}) => ({
  grant_type: "refresh_token",
  refresh_token: "refresh-1",
  client_id: "mongolgpt-cli",
  ...overrides,
})

const success = (overrides: Record<string, unknown> = {}) => ({
  access_token: "access-2",
  refresh_token: "refresh-2",
  expires_in: 600,
  token_type: "Bearer",
  ...overrides,
})

async function errorBody(response: Response) {
  const value: unknown = await response.json()
  if (!record(value) || typeof value.error !== "string" || typeof value.error_description !== "string") {
    throw new Error("OAuth error response shape is invalid")
  }
  return { error: value.error, error_description: value.error_description }
}

describe("CLI refresh token proxy", () => {
  test("binds the exchange to mongolgpt-cli and returns only the strict rotated token contract", async () => {
    let upstream:
      | { url: string; method?: string; contentType?: string; redirect?: RequestRedirect; body?: string }
      | undefined
    let verified = ""
    const response = await refreshCliToken(request(body()), {
      tokenEndpoint: endpoint,
      verifyToken: async (token) => {
        verified = token
        return { accountID: "acc_123" }
      },
      fetcher: async (input, init) => {
        upstream = {
          url: input instanceof Request ? input.url : input instanceof URL ? input.toString() : input,
          method: init?.method,
          contentType: new Headers(init?.headers).get("content-type") ?? undefined,
          redirect: init?.redirect,
          body: typeof init?.body === "string" ? init.body : undefined,
        }
        return Response.json({ ...success(), internal_secret: "must-not-pass" })
      },
    })

    expect(upstream).toEqual({
      url: endpoint,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      redirect: "error",
      body: "grant_type=refresh_token&refresh_token=refresh-1&client_id=mongolgpt-cli",
    })
    expect(verified).toBe("access-2")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toStartWith("application/json")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual(success())
  })

  test("rejects wrong media types, clients, unknown fields, and oversized tokens before upstream", async () => {
    let calls = 0
    const invoke = (req: Request) =>
      refreshCliToken(req, {
        tokenEndpoint: endpoint,
        verifyToken: async () => ({ accountID: "acc_123" }),
        fetcher: async () => {
          calls++
          return Response.json(success())
        },
      })

    const responses = [
      await invoke(request(body(), "text/plain")),
      await invoke(request(body({ client_id: "another-client" }))),
      await invoke(request(body({ extra: "not-allowed" }))),
      await invoke(request(body({ refresh_token: "x".repeat(16 * 1024 + 1) }))),
    ]

    expect(responses.map((response) => response.status)).toEqual([415, 400, 400, 400])
    expect((await errorBody(responses[1])).error).toBe("invalid_client")
    expect(calls).toBe(0)
    for (const response of responses) expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("rejects unsupported grants and malformed JSON without contacting upstream", async () => {
    let calls = 0
    const input = {
      tokenEndpoint: endpoint,
      verifyToken: async () => ({ accountID: "acc_123" }),
      fetcher: async () => {
        calls++
        return Response.json(success())
      },
    }
    const unsupported = await refreshCliToken(request(body({ grant_type: "password" })), input)
    const malformed = await refreshCliToken(
      new Request("https://dev.mgpt.mn/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      input,
    )

    expect((await errorBody(unsupported)).error).toBe("unsupported_grant_type")
    expect((await errorBody(malformed)).error).toBe("invalid_request")
    expect(calls).toBe(0)
  })

  test("fails closed on redirects, non-JSON, malformed, or oversized upstream responses", async () => {
    const cases = [
      new Response(null, { status: 307, headers: { location: "https://attacker.example/token" } }),
      new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
      new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify(success({ access_token: "x".repeat(70 * 1024) })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]

    for (const upstream of cases) {
      const response = await refreshCliToken(request(body()), {
        tokenEndpoint: endpoint,
        verifyToken: async () => ({ accountID: "acc_123" }),
        fetcher: async (_input, init) => {
          expect(init?.redirect).toBe("error")
          return upstream
        },
      })
      expect(response.status).toBe(502)
      expect((await errorBody(response)).error).toBe("server_error")
    }
  })

  test("normalizes OAuth errors and strips upstream fields", async () => {
    const response = await refreshCliToken(request(body()), {
      tokenEndpoint: endpoint,
      verifyToken: async () => ({ accountID: "acc_123" }),
      fetcher: async () =>
        Response.json(
          { error: "invalid_grant", error_description: "Refresh token reused", debug: "must-not-pass" },
          { status: 400 },
        ),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_grant", error_description: "Refresh token reused" })
  })

  test("rejects rotated tokens for suspended, deleted, or auth-version-revoked accounts", async () => {
    const response = await refreshCliToken(request(body()), {
      tokenEndpoint: endpoint,
      verifyToken: async () => undefined,
      fetcher: async () => Response.json(success()),
    })

    expect(response.status).toBe(400)
    expect((await errorBody(response)).error).toBe("invalid_grant")
  })

  test("does not misreport account database failures as invalid credentials", async () => {
    const response = await refreshCliToken(request(body()), {
      tokenEndpoint: endpoint,
      verifyToken: async () => {
        throw new Error("database unavailable")
      },
      fetcher: async () => Response.json(success()),
    })

    expect(response.status).toBe(503)
    expect((await errorBody(response)).error).toBe("temporarily_unavailable")
  })
})

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
