import { describe, expect, test } from "bun:test"
import {
  AccountOverviewNotFoundError,
  AccountOverviewSuspendedError,
} from "@mongolgpt/console-core/account-overview.js"
import { RuntimeCapabilityError, verifyRuntimeCapability } from "@mongolgpt/runtime-auth"
import { nativeRuntimeTokenRequest } from "./runtime-token-handler"

const runtimeUrl = "https://runtime.dev.mgpt.mn"
const secret = "runtime-auth-secret-with-at-least-thirty-two-characters"
const otherSecret = "different-runtime-auth-secret-with-at-least-thirty-two-characters"
const now = 1_700_000_000
const account = { id: "acc_native_cli", email: "cli@mgpt.mn", authVersion: 17 }
const workspace = { id: "wrk_primary", name: "Primary workspace" }

function request(
  input: {
    method?: string
    authorization?: string
    origin?: string
    cookie?: string
    workspaceID?: string
    body?: BodyInit
  } = {},
) {
  const headers = new Headers()
  if (input.authorization !== undefined) headers.set("authorization", input.authorization)
  if (input.origin !== undefined) headers.set("origin", input.origin)
  if (input.cookie !== undefined) headers.set("cookie", input.cookie)
  if (input.workspaceID !== undefined) headers.set("x-org-id", input.workspaceID)
  if (input.body !== undefined) headers.set("content-type", "application/json")
  return new Request("https://dev.mgpt.mn/api/runtime-token", {
    method: input.method ?? "POST",
    headers,
    body: input.body,
  })
}

function handler(input: {
  request?: Request
  account?: typeof account
  runtimeUrl?: string
  secret?: string
  workspaces?:
    | readonly { id: string; name: string }[]
    | ((accountID: string) => Promise<readonly { id: string; name: string }[]>)
  authenticate?: (request: Request) => Promise<typeof account | undefined>
}) {
  const workspaces = input.workspaces
  return nativeRuntimeTokenRequest(input.request ?? request({ authorization: "Bearer cli-token" }), {
    runtimeUrl: "runtimeUrl" in input ? input.runtimeUrl : runtimeUrl,
    secret: "secret" in input ? input.secret! : secret,
    now: () => now,
    authenticate: input.authenticate ?? (async () => input.account ?? account),
    workspaces: typeof workspaces === "function" ? workspaces : async () => workspaces ?? [workspace],
  })
}

describe("native API runtime capability route", () => {
  test("POST without Origin issues a 90 second runtime-audience capability for the authenticated CLI account", async () => {
    const response = await handler({})

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("vary")).toBe("Origin")
    const body: unknown = await response.json()
    if (!runtimeTokenBody(body)) throw new Error("Runtime token response shape is invalid")
    expect(body.expiresAt).toBe((now + 90) * 1000)
    expect(body.account).toEqual({ id: account.id, email: account.email })
    expect(body.workspace).toEqual(workspace)

    const verified = await verifyRuntimeCapability({ token: body.token, audience: runtimeUrl, secret, now })
    expect(verified).toMatchObject({
      sub: account.id,
      workspaceID: workspace.id,
      authVersion: account.authVersion,
      aud: runtimeUrl,
      iat: now,
      exp: now + 90,
    })
    await expect(
      verifyRuntimeCapability({ token: body.token, audience: runtimeUrl, secret, now: now + 90 }),
    ).rejects.toBeInstanceOf(RuntimeCapabilityError)
    await expect(
      verifyRuntimeCapability({ token: body.token, audience: "https://other-runtime.dev.mgpt.mn", secret, now }),
    ).rejects.toBeInstanceOf(RuntimeCapabilityError)
    await expect(
      verifyRuntimeCapability({ token: body.token, audience: runtimeUrl, secret: otherSecret, now }),
    ).rejects.toBeInstanceOf(RuntimeCapabilityError)
  })

  test("allows only POST and rejects any Origin without CORS", async () => {
    let authenticated = 0
    const nonPost = await handler({
      request: request({ method: "GET", authorization: "Bearer cli-token" }),
      authenticate: async () => {
        authenticated++
        return account
      },
    })
    expect(nonPost.status).toBe(405)
    expect(nonPost.headers.get("allow")).toBe("POST")
    expect(authenticated).toBe(0)

    for (const origin of ["https://app.dev.mgpt.mn", "https://attacker.example", "null", ""]) {
      const response = await handler({
        request: request({ authorization: "Bearer cli-token", origin }),
        authenticate: async () => {
          authenticated++
          return account
        },
      })
      expect(response.status).toBe(403)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
      expect(await response.json()).toMatchObject({ error: "invalid_origin" })
    }
    expect(authenticated).toBe(0)
  })

  test("requires a strict bearer header and never authenticates cookie-only or malformed requests", async () => {
    for (const input of [
      {},
      { cookie: "mgpt_session=browser-session" },
      { authorization: "Basic cli-token" },
      { authorization: "Bearer" },
      { authorization: "Bearer cli-token extra" },
      { authorization: "Bearer cli-token,other" },
      { authorization: "Bearer\tcli-token" },
    ]) {
      let authenticated = 0
      const response = await handler({
        request: request(input),
        authenticate: async () => {
          authenticated++
          return account
        },
      })
      expect(response.status).toBe(401)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
      expect(await response.json()).toMatchObject({ error: "unauthorized" })
      expect(authenticated).toBe(0)
    }
  })

  test("returns unauthorized when CLI account verification fails or has been revoked", async () => {
    let authenticated = 0
    const response = await handler({
      authenticate: async () => {
        authenticated++
        return undefined
      },
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: "unauthorized" })
    expect(authenticated).toBe(1)
  })

  test("ignores body spoofing for account, workspace, ttl, and audience", async () => {
    const response = await handler({
      request: request({
        authorization: "Bearer cli-token",
        body: JSON.stringify({
          account: { id: "acc_attacker", email: "attacker@example.com", authVersion: 999 },
          workspace: { id: "wrk_foreign", name: "Foreign workspace" },
          workspaceID: "wrk_foreign",
          ttlSeconds: 120,
          audience: "https://attacker.example",
        }),
      }),
    })

    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    if (!runtimeTokenBody(body)) throw new Error("Runtime token response shape is invalid")
    expect(body.expiresAt).toBe((now + 90) * 1000)
    expect(body.account).toEqual({ id: account.id, email: account.email })
    expect(body.workspace).toEqual(workspace)
    expect(await verifyRuntimeCapability({ token: body.token, audience: runtimeUrl, secret, now })).toMatchObject({
      sub: account.id,
      workspaceID: workspace.id,
      authVersion: account.authVersion,
      exp: now + 90,
    })
  })

  test("resolves empty, multiple, explicit, and foreign workspace memberships", async () => {
    const empty = await handler({ workspaces: [] })
    expect(empty.status).toBe(403)
    expect(await empty.json()).toMatchObject({ error: "workspace_forbidden", workspaces: [] })

    const workspaces = [
      { id: "wrk_first", name: "First workspace" },
      { id: "wrk_second", name: "Second workspace" },
    ]
    const ambiguous = await handler({ workspaces })
    expect(ambiguous.status).toBe(409)
    expect(await ambiguous.json()).toMatchObject({ error: "workspace_required", workspaces })

    const selected = await handler({
      request: request({ authorization: "Bearer cli-token", workspaceID: "wrk_second" }),
      workspaces,
    })
    expect(selected.status).toBe(200)
    const body: unknown = await selected.json()
    if (!runtimeTokenBody(body)) throw new Error("Runtime token response shape is invalid")
    expect(body.workspace).toEqual(workspaces[1])
    expect(await verifyRuntimeCapability({ token: body.token, audience: runtimeUrl, secret, now })).toMatchObject({
      workspaceID: "wrk_second",
    })

    const malformedSelection = await handler({
      request: request({ authorization: "Bearer cli-token", workspaceID: "not-a-workspace" }),
      workspaces,
    })
    expect(malformedSelection.status).toBe(400)
    expect(await malformedSelection.json()).toMatchObject({ error: "invalid_request" })

    const foreign = await handler({
      request: request({ authorization: "Bearer cli-token", workspaceID: "wrk_foreign" }),
      workspaces,
    })
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toMatchObject({ error: "workspace_forbidden", workspaces })
  })

  test("fails closed for malformed memberships before signing", async () => {
    for (const workspaces of [
      [{ id: "not-a-workspace", name: "Bad ID" }],
      [{ id: "wrk_primary", name: " padded " }],
      [
        { id: "wrk_dupe", name: "One" },
        { id: "wrk_dupe", name: "Two" },
      ],
    ]) {
      await expect(handler({ workspaces })).rejects.toBeInstanceOf(TypeError)
    }
  })

  test("maps safe account overview errors without leaking details", async () => {
    const suspended = await handler({
      workspaces: asyncThrow(new AccountOverviewSuspendedError()),
    })
    expect(suspended.status).toBe(423)
    expect(await suspended.json()).toEqual({
      error: "account_suspended",
      message: "Таны MongolGPT бүртгэлийг түр түдгэлзүүлсэн байна.",
    })

    const missing = await handler({
      workspaces: asyncThrow(new AccountOverviewNotFoundError()),
    })
    expect(missing.status).toBe(401)
    expect(await missing.json()).toEqual({
      error: "unauthorized",
      message: "MongolGPT бүртгэлээр дахин нэвтэрнэ үү.",
    })
  })

  test("fails closed when runtime server configuration is invalid", async () => {
    for (const runtime of [undefined, "http://runtime.dev.mgpt.mn", "https://runtime.dev.mgpt.mn/path"]) {
      const response = await handler({ runtimeUrl: runtime })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: "runtime_not_configured",
        message: "MongolGPT runtime серверийн хаяг тохируулагдаагүй байна.",
      })
    }
    await expect(handler({ secret: "short" })).rejects.toBeInstanceOf(RuntimeCapabilityError)
  })

  test("works through a small Bun HTTP server for POST requests", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: (incoming) =>
        nativeRuntimeTokenRequest(incoming, {
          runtimeUrl,
          secret,
          now: () => now,
          authenticate: async (incomingRequest) => {
            expect(incomingRequest.headers.get("authorization")).toBe("Bearer cli-token")
            return account
          },
          workspaces: async (accountID) => {
            expect(accountID).toBe(account.id)
            return [workspace]
          },
        }),
    })

    const response = await fetch(new URL("/api/runtime-token", server.url), {
      method: "POST",
      headers: { authorization: "Bearer cli-token" },
    })
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    if (!runtimeTokenBody(body)) throw new Error("Runtime token response shape is invalid")
    expect(await verifyRuntimeCapability({ token: body.token, audience: runtimeUrl, secret, now })).toMatchObject({
      sub: account.id,
      workspaceID: workspace.id,
    })
  })
})

function asyncThrow(error: Error): () => Promise<never> {
  return async () => {
    throw error
  }
}

function runtimeTokenBody(value: unknown): value is {
  token: string
  expiresAt: number
  account: { id: string; email: string }
  workspace: { id: string; name: string }
} {
  return (
    record(value) &&
    typeof value.token === "string" &&
    typeof value.expiresAt === "number" &&
    record(value.account) &&
    typeof value.account.id === "string" &&
    typeof value.account.email === "string" &&
    record(value.workspace) &&
    typeof value.workspace.id === "string" &&
    typeof value.workspace.name === "string"
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
