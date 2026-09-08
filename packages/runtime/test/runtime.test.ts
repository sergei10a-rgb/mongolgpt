import { describe, expect, test } from "bun:test"
import { issueRuntimeCapability, runtimeGatewayHeader, verifyRuntimeCapability } from "@mongolgpt/runtime-auth"
import { createRuntimeDeployCommand, parseRuntimeDeployStage } from "../script/deploy"
import {
  createRuntimeProcessStarter,
  createRuntimeHandler,
  deriveRuntimeIdentity,
  hostedDirectory,
  RUNTIME_PROCESS_ID,
  sanitizeRuntimeDiagnostic,
  RuntimeFailure,
  type RuntimeProcess,
  type RuntimeSandbox,
  type RuntimeVariables,
} from "../src/runtime"

const appOrigin = "https://app.dev.mgpt.mn"
const consoleOrigin = "https://dev.mgpt.mn"
const runtimeOrigin = "https://runtime.dev.mgpt.mn"
const secret = "runtime-secret-that-is-longer-than-thirty-two-characters"
const authSecret = "runtime-auth-secret-that-is-longer-than-thirty-two-characters"

type Environment = RuntimeVariables & {
  Sandbox: string
}

function environment(): Environment {
  const limiter = {
    limit: async () => ({ success: true }),
  }
  return {
    Sandbox: "binding",
    MONGOLGPT_APP_ORIGIN: appOrigin,
    MONGOLGPT_CONSOLE_URL: consoleOrigin,
    MONGOLGPT_RUNTIME_AUTH_SECRET: authSecret,
    MONGOLGPT_RUNTIME_BURST_LIMITER: limiter,
    MONGOLGPT_RUNTIME_RATE_LIMITER: limiter,
    MONGOLGPT_RUNTIME_SECRET: secret,
    MONGOLGPT_RUNTIME_VERSION: "test",
    STAGE: "dev",
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function capability(input: Partial<Parameters<typeof issueRuntimeCapability>[0]> = {}) {
  return issueRuntimeCapability({
    accountID: "acc_123",
    workspaceID: "wrk_123",
    authVersion: 1,
    audience: runtimeOrigin,
    secret: authSecret,
    ttlSeconds: 90,
    ...input,
  })
}

function process(status: RuntimeProcess["status"] = "running") {
  const ports: number[] = []
  return {
    ports,
    value: {
      status,
      getStatus: async () => status,
      waitForPort: async (port) => {
        ports.push(port)
      },
    } satisfies RuntimeProcess,
  }
}

function sandbox(input: { existing?: RuntimeProcess | null; response?: Response; websocketResponse?: Response } = {}) {
  const started: Array<{
    command: string
    options: Parameters<RuntimeSandbox["startProcess"]>[1]
  }> = []
  const requests: Request[] = []
  const websocket: Request[] = []
  const running = process()

  return {
    started,
    requests,
    websocket,
    value: {
      getProcess: async () => input.existing ?? null,
      startProcess: async (command, options) => {
        started.push({ command, options })
        return running.value
      },
      containerFetch: async (request) => {
        requests.push(request)
        return input.response ?? Response.json({ ok: true })
      },
      wsConnect: async (request) => {
        websocket.push(request)
        return input.websocketResponse ?? new Response("websocket")
      },
    } satisfies RuntimeSandbox,
  }
}

function hostedRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("origin", appOrigin)
  if (!headers.has("cookie")) headers.set("cookie", "theme=dark; auth=console-session; analytics=1")
  return new Request(`${runtimeOrigin}${path}`, { ...init, headers })
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("MongolGPT Cloudflare runtime", () => {
  test("rejects oversized streamed requests without waiting for a stuck cancel", async () => {
    const runtime = sandbox()
    let cancelled = false
    const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })
    const response = await handler(
      hostedRequest("/session", {
        method: "POST",
        headers: { authorization: `Bearer ${await capability()}`, "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1))
          },
          cancel() {
            cancelled = true
            return new Promise(() => {})
          },
        }),
      }),
      environment(),
    )
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(runtime.started).toHaveLength(0)
    expect(runtime.requests).toHaveLength(0)
  })

  test("reports health only when both runtime secrets are configured", async () => {
    const handler = createRuntimeHandler<Environment>({ sandbox: () => sandbox().value })

    const healthy = await handler(hostedRequest("/global/health"), environment())
    expect(healthy.status).toBe(200)
    expect(healthy.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(healthy.headers.get("cache-control")).toBe("no-store")
    const healthyBody: unknown = await healthy.json()
    expect(healthyBody).toEqual({
      healthy: true,
      service: "mongolgpt-runtime",
      stage: "dev",
      version: "test",
    })

    const missing = environment()
    missing.MONGOLGPT_RUNTIME_AUTH_SECRET = ""
    const unhealthy = await handler(hostedRequest("/global/health"), missing)
    expect(unhealthy.status).toBe(503)
    expect(await unhealthy.json()).toMatchObject({ healthy: false })

    const missingVersion = environment()
    missingVersion.MONGOLGPT_RUNTIME_VERSION = "  "
    const versionless = await handler(hostedRequest("/global/health"), missingVersion)
    expect(versionless.status).toBe(503)
    expect(await versionless.json()).toMatchObject({ healthy: false })

    const missingConsole = environment()
    missingConsole.MONGOLGPT_CONSOLE_URL = ""
    const consoleless = await handler(hostedRequest("/global/health"), missingConsole)
    expect(consoleless.status).toBe(503)
    expect(await consoleless.json()).toMatchObject({ healthy: false })

    const missingStage = environment()
    missingStage.STAGE = "  "
    const stageless = await handler(hostedRequest("/global/health"), missingStage)
    expect(stageless.status).toBe(503)
    expect(await stageless.json()).toMatchObject({ healthy: false })

    const head = await handler(new Request(`${runtimeOrigin}/global/health`, { method: "HEAD" }), environment())
    expect(head.status).toBe(200)
    expect(head.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(head.headers.get("cache-control")).toBe("no-store")
  })

  test("answers exact-origin credentialed preflight without a console fetch dependency", async () => {
    const handler = createRuntimeHandler<Environment>({ sandbox: () => sandbox().value })
    const response = await handler(
      hostedRequest("/session", {
        method: "OPTIONS",
        headers: { "access-control-request-method": "POST" },
      }),
      environment(),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization")
    expect(await Bun.file(new URL("../src/runtime.ts", import.meta.url)).text()).not.toContain("/auth/status")
  })

  test("rejects requests from origins other than the hosted app before authentication", async () => {
    let sandboxes = 0
    const handler = createRuntimeHandler<Environment>({
      sandbox: () => {
        sandboxes += 1
        return sandbox().value
      },
    })
    const response = await handler(
      new Request(`${runtimeOrigin}/session`, {
        headers: { origin: "https://attacker.example", authorization: `Bearer ${await capability()}` },
      }),
      environment(),
    )

    expect(response.status).toBe(403)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.has("access-control-allow-origin")).toBe(false)
    expect(response.headers.has("access-control-allow-credentials")).toBe(false)
    const body: unknown = await response.json()
    expect(body).toEqual({ error: "MongolGPT веб апп-аас хүсэлт илгээнэ үү." })
    expect(sandboxes).toBe(0)
  })

  test("exchanges a valid bearer capability for a hardened host-only runtime cookie", async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await capability({ now })
    const handler = createRuntimeHandler<Environment>({ sandbox: () => sandbox().value })
    const response = await handler(
      hostedRequest("/auth/session", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, cookie: "__Host-mongolgpt-runtime=stale-token" },
      }),
      environment(),
    )

    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toEqual({
      authenticated: true,
      account: { id: "acc_123" },
      workspace: { id: "wrk_123" },
      expiresAt: (now + 90) * 1000,
    })
    const cookie = response.headers.get("set-cookie")
    expect(cookie).toMatch(
      new RegExp(`^__Host-mongolgpt-runtime=${token}; Max-Age=([1-9]\\d*); Path=/; Secure; HttpOnly; SameSite=Strict$`),
    )
    expect(cookie).not.toContain("Domain=")
    expect(Number(/Max-Age=(\d+)/.exec(cookie ?? "")?.[1])).toBeLessThanOrEqual(90)
  })

  test("verifies the runtime auth secret without trimming it", async () => {
    const exactSecret = ` ${authSecret} `
    const token = await capability({ secret: exactSecret })
    const env = environment()
    env.MONGOLGPT_RUNTIME_AUTH_SECRET = exactSecret
    const handler = createRuntimeHandler<Environment>({ sandbox: () => sandbox().value })

    const response = await handler(
      hostedRequest("/auth/session", { method: "POST", headers: { authorization: `Bearer ${token}` } }),
      env,
    )

    expect(response.status).toBe(200)
  })

  test("authenticates HTTP and WebSocket requests through only the runtime cookie", async () => {
    const token = await capability()
    const runtime = sandbox()
    const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })

    const session = await handler(
      hostedRequest("/auth/session", { headers: { cookie: `__Host-mongolgpt-runtime=${token}` } }),
      environment(),
    )
    expect(session.status).toBe(200)
    const sessionBody: unknown = await session.json()
    expect(sessionBody).toMatchObject({
      authenticated: true,
      account: { id: "acc_123" },
      workspace: { id: "wrk_123" },
    })

    const http = await handler(
      hostedRequest("/project", { headers: { cookie: `__Host-mongolgpt-runtime=${token}` } }),
      environment(),
    )
    expect(http.status).toBe(200)
    expect(http.headers.get("cache-control")).toBe("no-store")
    expect(runtime.requests).toHaveLength(1)

    const websocket = await handler(
      hostedRequest("/pty/pty_123/connect", {
        headers: { cookie: `__Host-mongolgpt-runtime=${token}`, upgrade: "websocket" },
      }),
      environment(),
    )
    expect(await websocket.text()).toBe("websocket")
    expect(runtime.websocket).toHaveLength(1)
  })

  test("closes an upgraded WebSocket when its runtime capability expires", async () => {
    const token = await capability()
    const closeCalls: Array<{ code?: number; reason?: string }> = []
    const socket = Object.assign(new EventTarget(), {
      close(code?: number, reason?: string) {
        closeCalls.push({ code, reason })
      },
    })
    const websocketResponse = new Response("websocket")
    Object.defineProperty(websocketResponse, "webSocket", { value: socket })

    let expire: (() => void) | undefined
    let delay = -1
    let cancelled = 0
    const runtime = sandbox({ websocketResponse })
    const handler = createRuntimeHandler<Environment>({
      sandbox: () => runtime.value,
      schedule(callback, timeout) {
        expire = callback
        delay = timeout
        return () => {
          cancelled += 1
        }
      },
    })

    const response = await handler(
      hostedRequest("/pty/pty_123/connect", {
        headers: { cookie: `__Host-mongolgpt-runtime=${token}`, upgrade: "websocket" },
      }),
      environment(),
    )

    expect(response).toBe(websocketResponse)
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(90_000)
    expect(expire).toBeFunction()
    expire?.()
    expect(closeCalls).toEqual([{ code: 4001, reason: "MongolGPT runtime сесс дууссан" }])

    socket.dispatchEvent(new Event("close"))
    expect(cancelled).toBe(1)
  })

  test("ignores broad console auth cookies and rejects malformed token sources", async () => {
    const token = await capability()
    const handler = createRuntimeHandler<Environment>({ sandbox: () => sandbox().value })

    const broadCookie = await handler(hostedRequest("/auth/session"), environment())
    expect(broadCookie.status).toBe(401)
    const broadCookieBody: unknown = await broadCookie.json()
    expect(broadCookieBody).toEqual({ authenticated: false })

    const malformedBearer = await handler(
      hostedRequest("/auth/session", { headers: { authorization: `Bearer ${token}, Bearer another-token` } }),
      environment(),
    )
    expect(malformedBearer.status).toBe(401)

    const duplicateRuntimeCookie = await handler(
      hostedRequest("/auth/session", {
        headers: { cookie: `__Host-mongolgpt-runtime=${token}; __Host-mongolgpt-runtime=${token}` },
      }),
      environment(),
    )
    expect(duplicateRuntimeCookie.status).toBe(401)

    const emptyRuntimeCookie = await handler(
      hostedRequest("/auth/session", { headers: { cookie: "__Host-mongolgpt-runtime=" } }),
      environment(),
    )
    expect(emptyRuntimeCookie.status).toBe(401)
  })

  test("rejects capabilities with the wrong audience, secret, or expiry", async () => {
    const handler = createRuntimeHandler<Environment>({ sandbox: () => sandbox().value })
    const tokens = await Promise.all([
      capability({ audience: "https://runtime.other.mgpt.mn" }),
      capability({ secret: "different-runtime-auth-secret-that-is-longer-than-thirty-two-characters" }),
      capability({ now: 0, ttlSeconds: 60 }),
    ])

    for (const token of tokens) {
      const response = await handler(
        hostedRequest("/auth/session", { method: "POST", headers: { authorization: `Bearer ${token}` } }),
        environment(),
      )
      expect(response.status).toBe(401)
      const body: unknown = await response.json()
      expect(body).toEqual({ authenticated: false })
    }
  })

  test("clears the hardened runtime cookie on logout", async () => {
    const handler = createRuntimeHandler<Environment>({ sandbox: () => sandbox().value })
    const response = await handler(hostedRequest("/auth/session", { method: "DELETE" }), environment())

    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toEqual({ authenticated: false })
    expect(response.headers.get("set-cookie")).toBe(
      "__Host-mongolgpt-runtime=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict",
    )
  })

  test("starts a workspace-isolated server and proxies with internal credentials", async () => {
    const runtime = sandbox()
    const ids: string[] = []
    const scopes: Array<{ accountID: string; workspaceID: string }> = []
    const handler = createRuntimeHandler<Environment>({
      sandbox: async (_env, id, scope) => {
        ids.push(id)
        scopes.push(scope)
        return runtime.value
      },
    })
    const token = await capability()
    const response = await handler(
      hostedRequest("/session", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-mongolgpt-directory": encodeURIComponent("projects/demo"),
          "x-org-id": "wrk_browser_controlled",
          [runtimeGatewayHeader]: "browser-controlled-value",
        },
        body: "{}",
      }),
      environment(),
    )

    expect(response.status).toBe(200)
    expect(scopes).toEqual([{ accountID: "acc_123", workspaceID: "wrk_123" }])
    expect(ids[0]).toStartWith("workspace-")
    expect(ids[0]).not.toContain("acc_123")
    expect(runtime.started).toHaveLength(1)
    expect(runtime.started[0]?.options.env.MONGOLGPT_SERVER_PASSWORD).toHaveLength(43)
    expect(runtime.started[0]?.options.env).toMatchObject({
      NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      MONGOLGPT_RUNTIME_MODE: "hosted",
      MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
      MONGOLGPT_CONSOLE_URL: consoleOrigin,
      MONGOLGPT_API_KEY: "runtime",
    })
    expect(Object.values(runtime.started[0]?.options.env ?? {})).not.toContain(token)
    expect(runtime.started[0]?.options.env.MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE).toBeUndefined()
    expect(runtime.requests).toHaveLength(1)
    expect(runtime.requests[0]?.headers.get("cookie")).toBeNull()
    expect(runtime.requests[0]?.headers.get("authorization")).toStartWith("Basic ")
    expect(runtime.requests[0]?.headers.get("authorization")).not.toContain(token)
    const gatewayToken = runtime.requests[0]?.headers.get(runtimeGatewayHeader)
    expect(gatewayToken).toBeString()
    expect(gatewayToken).not.toBe("browser-controlled-value")
    const gateway = await verifyRuntimeCapability({
      token: gatewayToken!,
      audience: consoleOrigin,
      secret: authSecret,
    })
    expect(gateway).toMatchObject({
      sub: "acc_123",
      workspaceID: "wrk_123",
      authVersion: 1,
      aud: consoleOrigin,
    })
    expect(runtime.requests[0]?.headers.get("x-org-id")).toBe("wrk_123")
    expect(decodeURIComponent(runtime.requests[0]?.headers.get("x-mongolgpt-directory") ?? "")).toBe(
      "/workspace/projects/demo",
    )
  })

  test("enables authenticated checkpoint startup without passing backup keys to the child", async () => {
    const runtime = sandbox()
    runtime.value.containerFetch = async (request) => {
      runtime.requests.push(request)
      return Response.json(
        { healthy: true, version: "test" },
        {
          headers: {
            "x-mongolgpt-runtime-history": "checkpoint-v1",
            "x-mongolgpt-runtime-isolation": "cgroup-v1",
            "x-mongolgpt-runtime-publication": "tool-pty-v1",
          },
        },
      )
    }
    const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })
    const response = await handler(
      hostedRequest("/project", { headers: { authorization: `Bearer ${await capability()}` } }),
      { ...environment(), MONGOLGPT_CLOUD_HISTORY: "true" },
    )
    expect(response.status).toBe(200)
    expect(runtime.started).toHaveLength(1)
    expect(runtime.started[0].options.env).toMatchObject({
      MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE: "true",
      MONGOLGPT_RUNTIME_SUPERVISOR: "true",
      MONGOLGPT_CLOUD_HISTORY: "true",
      MONGOLGPT_DB: "/workspace/.mongolgpt/runtime.sqlite",
      XDG_STATE_HOME: "/workspace/.mongolgpt/state",
    })
    expect(runtime.started[0].options.env.MONGOLGPT_RUNTIME_BACKUP_KEYS).toBeUndefined()
    expect(runtime.started[0].command).toBe("/usr/local/bin/mongolgpt serve --hostname 0.0.0.0 --port 4096")
    expect(new URL(runtime.requests[0].url).pathname).toBe("/global/health")
    expect(runtime.requests[0].headers.get("authorization")).toStartWith("Basic ")
  })

  const missingReceipts: Record<string, string>[] = [
    {},
    { "x-mongolgpt-runtime-history": "checkpoint-v1" },
    { "x-mongolgpt-runtime-isolation": "cgroup-v1" },
    { "x-mongolgpt-runtime-history": "checkpoint-v1", "x-mongolgpt-runtime-isolation": "cgroup-v1" },
    {
      "x-mongolgpt-runtime-history": "checkpoint-v1",
      "x-mongolgpt-runtime-isolation": "cgroup-v1",
      "x-mongolgpt-runtime-publication": "old",
    },
    {
      "x-mongolgpt-runtime-history": "checkpoint-v1",
      "x-mongolgpt-runtime-isolation": "cgroup-v1",
      "x-mongolgpt-runtime-publication": "tool-v1",
    },
  ]
  test.each(missingReceipts)(
    "does not reuse a server missing a restore, isolation or publication receipt (%j)",
    async (headers) => {
      const runtime = sandbox({ existing: process().value })
      runtime.value.containerFetch = async (request) => {
        runtime.requests.push(request)
        return Response.json({ healthy: true, version: "old-server" }, { headers })
      }
      const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })
      const response = await handler(
        hostedRequest("/project", { headers: { authorization: `Bearer ${await capability()}` } }),
        { ...environment(), MONGOLGPT_CLOUD_HISTORY: "true" },
      )
      expect(response.status).toBe(502)
      expect(runtime.started).toHaveLength(0)
      expect(runtime.requests).toHaveLength(1)
      expect(new URL(runtime.requests[0].url).pathname).toBe("/global/health")
    },
  )

  test("reuses a checkpoint-ready server only after authenticated schema validation", async () => {
    const runtime = sandbox({ existing: process().value })
    runtime.value.containerFetch = async (request) => {
      runtime.requests.push(request)
      return Response.json(
        { healthy: true, version: "current" },
        {
          headers: {
            "x-mongolgpt-runtime-history": "checkpoint-v1",
            "x-mongolgpt-runtime-isolation": "cgroup-v1",
            "x-mongolgpt-runtime-publication": "tool-pty-v1",
          },
        },
      )
    }
    const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })
    const response = await handler(
      hostedRequest("/project", { headers: { authorization: `Bearer ${await capability()}` } }),
      { ...environment(), MONGOLGPT_CLOUD_HISTORY: "true" },
    )
    expect(response.status).toBe(200)
    expect(runtime.started).toHaveLength(0)
    expect(runtime.requests).toHaveLength(2)
  })

  test("reuses a healthy server process instead of starting another", async () => {
    const running = process()
    const runtime = sandbox({ existing: running.value })
    const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })

    const response = await handler(
      hostedRequest("/project", { headers: { authorization: `Bearer ${await capability()}` } }),
      environment(),
    )

    expect(response.status).toBe(200)
    expect(runtime.started).toHaveLength(0)
    expect(running.ports).toEqual([4096])
  })

  test("normalizes SDK query directories before forwarding to either API generation", async () => {
    const token = await capability()
    for (const route of [
      "/provider?directory=%2F",
      "/provider?directory=projects%2Fdemo",
      "/api/location?directory=projects%2Fdemo&location%5Bdirectory%5D=projects%2Fdemo",
    ]) {
      const runtime = sandbox()
      const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })
      const response = await handler(
        hostedRequest(route, { headers: { authorization: `Bearer ${token}` } }),
        environment(),
      )
      expect(response.status).toBe(200)
      const expected = route === "/provider?directory=%2F" ? "/workspace" : "/workspace/projects/demo"
      const forwarded = runtime.requests[0]!
      const url = new URL(forwarded.url)
      expect(url.searchParams.get("directory")).toBe(expected)
      if (url.pathname.startsWith("/api/")) expect(url.searchParams.get("location[directory]")).toBe(expected)
      expect(decodeURIComponent(forwarded.headers.get("x-mongolgpt-directory")!)).toBe(expected)
    }
  })

  test("rejects unsafe, duplicate and conflicting directory selectors before sandbox access", async () => {
    const token = await capability()
    const runtime = sandbox()
    const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })
    for (const route of [
      "/provider?directory=%2Fetc",
      "/provider?directory=..%2Fother",
      "/provider?directory=%252e%252e%252fother",
      "/provider?directory=%25252e%25252e%25252fother",
      "/provider?directory=%2Fworkspace%2F%25252e%25252e%2Fetc",
      "/provider?directory=projects%5Cother",
      "/provider?directory=%2Fworkspace&directory=%2Fetc",
      "/api/location?location%5Bdirectory%5D=%2Fetc",
      "/api/location?location%5Bdirectory%5D=%2Fworkspace&location%5Bdirectory%5D=%2Fetc",
      "/api/location?directory=one&location%5Bdirectory%5D=two",
    ]) {
      const response = await handler(
        hostedRequest(route, { headers: { authorization: `Bearer ${token}` } }),
        environment(),
      )
      expect(response.status).toBe(400)
    }
    const conflicting = await handler(
      hostedRequest("/provider?directory=one", {
        headers: { authorization: `Bearer ${token}`, "x-mongolgpt-directory": encodeURIComponent("two") },
      }),
      environment(),
    )
    expect(conflicting.status).toBe(400)
    expect(runtime.started).toHaveLength(0)
    expect(runtime.requests).toHaveLength(0)
  })

  test("preserves matching directory selectors and unrelated query parameters", async () => {
    const runtime = sandbox()
    const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })
    const response = await handler(
      hostedRequest("/file?directory=projects%2Fdemo&path=src%2Findex.ts", {
        headers: {
          authorization: `Bearer ${await capability()}`,
          "x-mongolgpt-directory": encodeURIComponent("/workspace/projects/demo"),
        },
      }),
      environment(),
    )
    expect(response.status).toBe(200)
    const url = new URL(runtime.requests[0]!.url)
    expect(url.searchParams.get("directory")).toBe("/workspace/projects/demo")
    expect(url.searchParams.get("path")).toBe("src/index.ts")
  })

  test("preserves body, method and abort signal while normalizing query selectors", async () => {
    const token = await capability()
    for (const method of ["HEAD", "POST"]) {
      const controller = new AbortController()
      const runtime = sandbox()
      const handler = createRuntimeHandler<Environment>({ sandbox: () => runtime.value })
      const body = method === "POST" ? JSON.stringify({ title: "Synthetic QA" }) : undefined
      const response = await handler(
        hostedRequest("/session?directory=projects%2Fdemo", {
          method,
          signal: controller.signal,
          redirect: "manual",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body,
        }),
        environment(),
      )
      expect(response.status).toBe(200)
      const forwarded = runtime.requests[0]!
      expect(forwarded.method).toBe(method)
      expect(forwarded.redirect).toBe("manual")
      expect(await forwarded.text()).toBe(body ?? "")
      controller.abort()
      expect(forwarded.signal.aborted).toBe(true)
    }
  })

  test("returns safe stage-specific diagnostics for sandbox startup and proxy failures", async () => {
    const token = await capability()
    const running = process()
    const base = sandbox().value
    const scenarios: Array<{
      code: string
      message: string
      value: RuntimeSandbox
      headers?: Record<string, string>
    }> = [
      {
        code: "runtime_process_lookup_failed",
        message: "Cloud runtime процессийн төлөвийг шалгаж чадсангүй.",
        value: {
          ...base,
          getProcess: async () => {
            throw new Error("provider detail must stay private")
          },
        },
      },
      {
        code: "runtime_process_start_failed",
        message: "Cloud runtime процессийг эхлүүлж чадсангүй.",
        value: {
          ...base,
          getProcess: async () => null,
          startProcess: async () => {
            throw new Error("provider detail must stay private")
          },
        },
      },
      {
        code: "runtime_process_exited",
        message: "Cloud runtime процесс сервер бэлэн болохоос өмнө зогслоо.",
        value: {
          ...base,
          getProcess: async () => null,
          startProcess: async () => process("completed").value,
        },
      },
      {
        code: "runtime_process_status_failed",
        message: "Cloud runtime процессийн ажиллагааны төлөвийг уншиж чадсангүй.",
        value: {
          ...base,
          getProcess: async () => ({
            ...running.value,
            getStatus: async () => {
              throw new Error("provider detail must stay private")
            },
          }),
        },
      },
      {
        code: "runtime_process_port_timeout",
        message: "Cloud runtime сервер хугацаандаа бэлэн болсонгүй.",
        value: {
          ...base,
          getProcess: async () => ({
            ...running.value,
            waitForPort: async () => {
              throw new Error("provider detail must stay private")
            },
          }),
        },
      },
      {
        code: "runtime_proxy_failed",
        message: "Cloud runtime хүсэлтийг контейнер рүү дамжуулж чадсангүй.",
        value: {
          ...base,
          getProcess: async () => running.value,
          containerFetch: async () => {
            throw new Error("provider detail must stay private")
          },
        },
      },
      {
        code: "runtime_websocket_proxy_failed",
        message: "Cloud runtime-ийн шууд холболтыг контейнер рүү дамжуулж чадсангүй.",
        headers: { upgrade: "websocket" },
        value: {
          ...base,
          getProcess: async () => running.value,
          wsConnect: async () => {
            throw new Error("provider detail must stay private")
          },
        },
      },
    ]

    for (const scenario of scenarios) {
      const reported: string[] = []
      const handler = createRuntimeHandler<Environment>({
        sandbox: () => scenario.value,
        report: (failure) => reported.push(failure.code),
      })
      const response = await handler(
        hostedRequest("/path", {
          headers: scenario.headers?.upgrade
            ? { cookie: `__Host-mongolgpt-runtime=${token}`, ...scenario.headers }
            : { authorization: `Bearer ${token}` },
        }),
        environment(),
      )

      expect(response.status).toBe(502)
      const body = await response.json()
      expect(body).toEqual({
        error: scenario.code,
        code: scenario.code,
        message: scenario.message,
      })
      expect(reported).toEqual([scenario.code])
      expect(JSON.stringify(body)).not.toContain("provider detail")
    }

    const reported: string[] = []
    const handler = createRuntimeHandler<Environment>({
      sandbox: () => {
        throw new Error("provider detail must stay private")
      },
      report: (failure) => reported.push(failure.code),
    })
    const response = await handler(
      hostedRequest("/path", { headers: { authorization: `Bearer ${token}` } }),
      environment(),
    )
    const body = await response.json()
    expect(body).toEqual({
      error: "runtime_unavailable",
      code: "runtime_unavailable",
      message: "Cloud coding runtime-г эхлүүлж чадсангүй. Түр хүлээгээд дахин оролдоно уу.",
    })
    expect(reported).toEqual(["runtime_unavailable"])
    expect(JSON.stringify(body)).not.toContain("provider detail")
  })

  test("recovers failed port-watch streams only when the authenticated application is healthy", async () => {
    const token = await capability()
    const identity = await deriveRuntimeIdentity("acc_123", "wrk_123", secret)
    const watched = {
      ...process().value,
      waitForPort: async () => {
        throw new Error("Port watch stream ended unexpectedly")
      },
    }
    for (const existing of [false, true]) {
      const runtime = sandbox()
      const probes: Request[] = []
      const reports: RuntimeFailure[] = []
      const handler = createRuntimeHandler<Environment>({
        sandbox: () => ({
          ...runtime.value,
          getProcess: async () => (existing ? watched : null),
          startProcess: async () => watched,
          containerFetch: async (request, port) => {
            if (new URL(request.url).pathname !== "/global/health") return runtime.value.containerFetch(request)
            expect(port).toBe(4096)
            probes.push(request)
            return Response.json({ healthy: true, version: "0.1.1" })
          },
        }),
        report: (failure) => reports.push(failure),
      })
      const response = await handler(
        hostedRequest("/session", { headers: { authorization: `Bearer ${token}` } }),
        environment(),
      )
      expect(response.status).toBe(200)
      const body: unknown = await response.json()
      expect(body).toEqual({ ok: true })
      expect(probes).toHaveLength(1)
      expect(probes[0].url).toBe("http://localhost/global/health")
      expect(probes[0].redirect).toBe("manual")
      expect(Array.from(probes[0].headers.keys())).toEqual(["authorization"])
      expect(probes[0].headers.get("authorization")).toBe(`Basic ${btoa(`mongolgpt:${identity.password}`)}`)
      expect(runtime.requests).toHaveLength(1)
      expect(reports).toHaveLength(0)
    }
  })

  test("keeps port-watch failures closed for invalid health responses without forwarding user requests", async () => {
    const token = await capability()
    const failed = {
      ...process().value,
      waitForPort: async () => {
        throw { code: "RPC_TRANSPORT_ERROR", context: { kind: "peer_closed" } }
      },
    }
    for (const health of [
      () => Response.json({ healthy: true, version: "0.1.1" }, { status: 401 }),
      () => new Response(null, { status: 302, headers: { location: "https://attacker.example" } }),
      () => new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }),
      () => Response.json({ healthy: false, version: "0.1.1" }),
      () => Response.json({ healthy: true }),
      () => Response.json({ healthy: true, version: " " }),
      () => Response.json({ healthy: true, version: 1 }),
      () => Response.json([{ healthy: true, version: "0.1.1" }]),
      () => new Response("broken-json", { headers: { "content-type": "application/json" } }),
      () => Response.json({ healthy: true, version: "0.1.1", extra: "x".repeat(1_024) }),
      () => {
        throw new Error("private probe credential detail")
      },
    ]) {
      const runtime = sandbox({ existing: failed })
      let probes = 0
      const handler = createRuntimeHandler<Environment>({
        sandbox: () => ({
          ...runtime.value,
          containerFetch: async (request) => {
            if (new URL(request.url).pathname !== "/global/health") return runtime.value.containerFetch(request)
            probes++
            return health()
          },
        }),
      })
      const response = await handler(
        hostedRequest("/session", { headers: { authorization: `Bearer ${token}` } }),
        environment(),
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({
        code: "runtime_process_port_timeout",
        diagnostic: { code: "RPC_TRANSPORT_ERROR", kind: "peer_closed" },
      })
      expect(probes).toBe(1)
      expect(runtime.requests).toHaveLength(0)
    }
  })

  test("cancels oversized fallback health bodies", async () => {
    let cancelled = false
    const handler = createRuntimeHandler<Environment>({
      sandbox: () => ({
        ...sandbox({
          existing: {
            ...process().value,
            waitForPort: async () => {
              throw new Error("watch failed")
            },
          },
        }).value,
        containerFetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(1_025))
              },
              cancel() {
                cancelled = true
                return new Promise<void>(() => {})
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      }),
    })
    const response = await handler(
      hostedRequest("/session", { headers: { authorization: `Bearer ${await capability()}` } }),
      environment(),
    )
    expect(response.status).toBe(502)
    expect(cancelled).toBe(true)
  })

  test("bounds fallback health checks even when the transport or response body ignores abort", async () => {
    for (const bodyStalls of [false, true]) {
      let signal: AbortSignal | undefined
      let cancelled = false
      const handler = createRuntimeHandler<Environment>({
        sandbox: () => ({
          ...sandbox({
            existing: {
              ...process().value,
              waitForPort: async () => {
                throw new Error("watch failed")
              },
            },
          }).value,
          containerFetch: async (request) => {
            signal = request.signal
            if (!bodyStalls) return new Promise<Response>(() => {})
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"healthy":true,"version":"0.1.1"}'))
                },
                cancel() {
                  cancelled = true
                },
              }),
              { headers: { "content-type": "application/json" } },
            )
          },
        }),
      })
      const startedAt = Date.now()
      const response = await handler(
        hostedRequest("/session", { headers: { authorization: `Bearer ${await capability()}` } }),
        environment(),
      )
      expect(response.status).toBe(502)
      expect(signal?.aborted).toBe(true)
      if (bodyStalls) expect(cancelled).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(7_500)
    }
  }, 15_000)

  test("exposes only allowlisted sandbox diagnostics in dev and keeps production unchanged", async () => {
    const token = await capability()
    const sdkError = (code: string, context: Record<string, unknown>) => ({
      errorResponse: { code, context, message: "secret https://internal.example/command" },
    })
    const reported: RuntimeFailure[] = []
    const devSandbox = sandbox().value
    const handler = createRuntimeHandler<Environment>({
      sandbox: () => ({
        ...devSandbox,
        getProcess: async () => {
          throw sdkError("RPC_TRANSPORT_ERROR", { kind: "upgrade_failed", originalMessage: "secret" })
        },
      }),
      report: (failure) => reported.push(failure),
    })

    const dev = await handler(hostedRequest("/path", { headers: { authorization: `Bearer ${token}` } }), environment())
    const devBody: unknown = await dev.json()
    expect(devBody).toEqual({
      error: "runtime_process_lookup_failed",
      code: "runtime_process_lookup_failed",
      message: "Cloud runtime процессийн төлөвийг шалгаж чадсангүй. Лавлах код: RPC_TRANSPORT_ERROR/upgrade_failed",
      diagnostic: { code: "RPC_TRANSPORT_ERROR", kind: "upgrade_failed" },
    })
    expect(reported[0]?.diagnostic).toEqual({ code: "RPC_TRANSPORT_ERROR", kind: "upgrade_failed" })
    expect(JSON.stringify(reported[0])).not.toContain("secret")

    const production = environment()
    production.STAGE = "production"
    const productionResponse = await handler(
      hostedRequest("/path", { headers: { authorization: `Bearer ${token}` } }),
      production,
    )
    const productionBody: unknown = await productionResponse.json()
    expect(productionBody).toEqual({
      error: "runtime_process_lookup_failed",
      code: "runtime_process_lookup_failed",
      message: "Cloud runtime процессийн төлөвийг шалгаж чадсангүй.",
    })
  })

  test("preserves only typed container availability reasons in dev", () => {
    for (const reason of [
      "container_starting",
      "container_unhealthy",
      "container_replaced",
      "rpc_upgrade_failed",
      "no_container_instance_available",
      "max_container_instances_exceeded",
      "container_unreachable",
    ]) {
      const error = {
        errorResponse: {
          code: "CONTAINER_UNAVAILABLE",
          context: { reason, originalMessage: "private-command-and-token" },
        },
      }
      const failure = RuntimeFailure.create("runtime_process_lookup_failed", error)
      expect(failure.diagnostic).toEqual({ code: "CONTAINER_UNAVAILABLE", reason })
      expect(failure.messageFor("dev")).toContain(`CONTAINER_UNAVAILABLE/${reason}`)
      expect(failure.messageFor("production")).not.toContain(reason)
      expect(JSON.stringify(failure)).not.toContain("private-command-and-token")
    }
    expect(sanitizeRuntimeDiagnostic({ code: "CONTAINER_UNAVAILABLE", context: { reason: "private-reason" } })).toEqual(
      { code: "CONTAINER_UNAVAILABLE" },
    )
    expect(
      sanitizeRuntimeDiagnostic({ code: "RPC_TRANSPORT_ERROR", context: { reason: "container_unreachable" } }),
    ).toEqual({ code: "RPC_TRANSPORT_ERROR" })
    expect(
      sanitizeRuntimeDiagnostic({ code: "OPERATION_INTERRUPTED", context: { reason: "container_unreachable" } }),
    ).toEqual({ code: "OPERATION_INTERRUPTED" })
  })

  test("preserves only bounded process exit codes for exited-before-ready diagnostics", () => {
    for (const exitCode of [0, 132, 137, 255]) {
      expect(
        sanitizeRuntimeDiagnostic({
          code: "PROCESS_EXITED_BEFORE_READY",
          context: { exitCode, command: "private-command", env: "private-env", logs: "private-logs" },
        }),
      ).toEqual({ code: "PROCESS_EXITED_BEFORE_READY", exitCode })
    }

    expect(
      sanitizeRuntimeDiagnostic({
        errorResponse: {
          code: "PROCESS_EXITED_BEFORE_READY",
          context: { exitCode: 132, command: "private-command" },
        },
      }),
    ).toEqual({ code: "PROCESS_EXITED_BEFORE_READY", exitCode: 132 })

    for (const exitCode of [-1, 256, 1.5, NaN, Infinity, "132", [132], null, undefined]) {
      expect(sanitizeRuntimeDiagnostic({ code: "PROCESS_EXITED_BEFORE_READY", context: { exitCode } })).toEqual({
        code: "PROCESS_EXITED_BEFORE_READY",
      })
    }

    expect(
      sanitizeRuntimeDiagnostic({
        code: "PROCESS_READY_TIMEOUT",
        context: { exitCode: 137 },
      }),
    ).toEqual({ code: "PROCESS_READY_TIMEOUT" })

    const hostile = {
      code: "PROCESS_EXITED_BEFORE_READY",
      context: {
        get exitCode() {
          throw new Error("private-token-and-command")
        },
      },
    }
    expect(sanitizeRuntimeDiagnostic(hostile)).toEqual({ code: "PROCESS_EXITED_BEFORE_READY" })
  })

  test("exposes process exit code diagnostics only in dev runtime responses", async () => {
    const token = await capability()
    const responseFor = async (stage: string, exitCode: number) => {
      const error = {
        errorResponse: {
          code: "PROCESS_EXITED_BEFORE_READY",
          context: {
            exitCode,
            command: "private-command",
            env: { MONGOLGPT_SERVER_PASSWORD: "private-password" },
            logs: "private-logs",
          },
        },
      }
      const running = process().value
      const handler = createRuntimeHandler<Environment>({
        sandbox: () => ({
          ...sandbox().value,
          getProcess: async () => ({
            ...running,
            waitForPort: async () => {
              throw error
            },
          }),
          containerFetch: async () => new Response("not ready", { status: 503 }),
        }),
      })
      const env = environment()
      env.STAGE = stage
      return handler(hostedRequest("/path", { headers: { authorization: `Bearer ${token}` } }), env)
    }

    for (const exitCode of [0, 132, 137]) {
      const devResponse = await responseFor("dev", exitCode)
      expect(devResponse.status).toBe(502)
      const devBody: unknown = await devResponse.json()
      expect(devBody).toEqual({
        error: "runtime_process_port_timeout",
        code: "runtime_process_port_timeout",
        message: `Cloud runtime сервер хугацаандаа бэлэн болсонгүй. Лавлах код: PROCESS_EXITED_BEFORE_READY, гаралтын код: ${exitCode}`,
        diagnostic: { code: "PROCESS_EXITED_BEFORE_READY", exitCode },
      })
      expect(JSON.stringify(devBody)).not.toContain("private-command")
      expect(JSON.stringify(devBody)).not.toContain("private-password")
      expect(JSON.stringify(devBody)).not.toContain("private-logs")
    }

    const productionResponse = await responseFor("production", 132)
    expect(productionResponse.status).toBe(502)
    const productionBody: unknown = await productionResponse.json()
    expect(productionBody).toEqual({
      error: "runtime_process_port_timeout",
      code: "runtime_process_port_timeout",
      message: "Cloud runtime сервер хугацаандаа бэлэн болсонгүй.",
    })
  })

  test("sanitizes structured diagnostics across sandbox failure phases", async () => {
    const token = await capability()
    const error = (code: string, context: Record<string, unknown>) => ({
      errorResponse: { code, context, message: "do not expose this" },
    })
    const running = process().value
    const base = sandbox().value
    const scenarios: Array<{ expected: string; value: RuntimeSandbox }> = [
      {
        expected: "CONTAINER_UNAVAILABLE/rpc_upgrade_failed",
        value: {
          ...base,
          getProcess: async () => {
            throw error("CONTAINER_UNAVAILABLE", { reason: "rpc_upgrade_failed" })
          },
        },
      },
      {
        expected: "OPERATION_INTERRUPTED/runtime_replaced",
        value: {
          ...base,
          getProcess: async () => null,
          startProcess: async () => {
            throw error("OPERATION_INTERRUPTED", { reason: "runtime_replaced" })
          },
        },
      },
      {
        expected: "OPERATION_INTERRUPTED/transport_disposed",
        value: {
          ...base,
          getProcess: async () => ({
            ...running,
            getStatus: async () => {
              throw error("OPERATION_INTERRUPTED", { reason: "transport_disposed" })
            },
          }),
        },
      },
      {
        expected: "RPC_TRANSPORT_ERROR/peer_closed",
        value: {
          ...base,
          getProcess: async () => ({
            ...running,
            waitForPort: async () => {
              throw error("RPC_TRANSPORT_ERROR", { kind: "peer_closed" })
            },
          }),
        },
      },
      {
        expected: "SERVICE_NOT_RESPONDING",
        value: {
          ...base,
          getProcess: async () => running,
          containerFetch: async () => {
            throw error("SERVICE_NOT_RESPONDING", {})
          },
        },
      },
    ]

    for (const scenario of scenarios) {
      const reported: RuntimeFailure[] = []
      const response = await createRuntimeHandler<Environment>({
        sandbox: () => scenario.value,
        report: (failure) => reported.push(failure),
      })(hostedRequest("/path", { headers: { authorization: `Bearer ${token}` } }), environment())
      const body = await response.json()
      const [expectedCode, expectedDetail] = scenario.expected.split("/")
      const detailKey = expectedCode === "RPC_TRANSPORT_ERROR" ? "kind" : "reason"
      expect(body).toMatchObject({
        diagnostic: {
          code: expectedCode,
          ...(expectedDetail ? { [detailKey]: expectedDetail } : {}),
        },
      })
      expect(reported[0]?.diagnostic).toMatchObject({
        code: expectedCode,
        ...(expectedDetail ? { [detailKey]: expectedDetail } : {}),
      })
      expect(JSON.stringify(body)).not.toContain("do not expose this")
    }
  })

  test("drops unknown and hostile sandbox metadata without throwing or leaking", async () => {
    const token = await capability()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const hostile = {
      get errorResponse() {
        throw new Error("private error")
      },
      context: cyclic,
    }
    const reported: RuntimeFailure[] = []
    const response = await createRuntimeHandler<Environment>({
      sandbox: () => ({
        ...sandbox().value,
        getProcess: async () => {
          throw hostile
        },
      }),
      report: (failure) => reported.push(failure),
    })(hostedRequest("/path", { headers: { authorization: `Bearer ${token}` } }), environment())
    const responseBody: unknown = await response.json()
    expect(responseBody).toEqual({
      error: "runtime_process_lookup_failed",
      code: "runtime_process_lookup_failed",
      message: "Cloud runtime процессийн төлөвийг шалгаж чадсангүй.",
    })
    expect(reported[0]?.diagnostic).toBeUndefined()
  })

  test("does not copy unknown codes or unrelated context fields into diagnostics", () => {
    const privateValue = "private-token-and-command"
    const cyclic: Record<string, unknown> = { code: "RPC_TRANSPORT_ERROR" }
    cyclic.context = cyclic
    expect(sanitizeRuntimeDiagnostic(cyclic)).toEqual({ code: "RPC_TRANSPORT_ERROR" })
    expect(sanitizeRuntimeDiagnostic({ code: privateValue })).toBeUndefined()
    expect(sanitizeRuntimeDiagnostic({ errorResponse: { code: "toString" } })).toBeUndefined()
    expect(
      sanitizeRuntimeDiagnostic({
        code: "RPC_TRANSPORT_ERROR",
        context: { kind: privateValue, reason: "runtime_replaced", originalMessage: privateValue },
      }),
    ).toEqual({ code: "RPC_TRANSPORT_ERROR" })
    expect(
      sanitizeRuntimeDiagnostic({
        errorResponse: { code: "OPERATION_INTERRUPTED", context: { reason: privateValue, kind: "peer_closed" } },
      }),
    ).toEqual({ code: "OPERATION_INTERRUPTED" })

    const remote = {
      get code() {
        throw new Error(privateValue)
      },
      errorResponse: {
        code: "RPC_TRANSPORT_ERROR",
        context: {
          get kind() {
            throw new Error(privateValue)
          },
        },
      },
    }
    expect(sanitizeRuntimeDiagnostic(remote)).toEqual({ code: "RPC_TRANSPORT_ERROR" })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(sanitizeRuntimeDiagnostic(revoked.proxy)).toBeUndefined()
  })

  test("sanitizes factory failures and never retains the raw error in reporting", async () => {
    const token = await capability()
    const reported: RuntimeFailure[] = []
    const raw = Object.assign(new Error("private-token-and-command"), {
      code: "CONTAINER_UNAVAILABLE",
      context: { reason: "rpc_upgrade_failed", originalMessage: "private-token-and-command" },
    })
    const handler = createRuntimeHandler<Environment>({
      sandbox: () => {
        throw raw
      },
      report: (failure) => reported.push(failure),
    })
    const env = environment()
    env.STAGE = " dev "
    const response = await handler(
      hostedRequest("/path", {
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    )
    expect(response.status).toBe(502)
    const body: unknown = await response.json()
    expect(body).toEqual({
      error: "runtime_unavailable",
      code: "runtime_unavailable",
      message:
        "Cloud coding runtime-г эхлүүлж чадсангүй. Түр хүлээгээд дахин оролдоно уу. Лавлах код: CONTAINER_UNAVAILABLE/rpc_upgrade_failed",
      diagnostic: { code: "CONTAINER_UNAVAILABLE", reason: "rpc_upgrade_failed" },
    })
    expect(reported).toHaveLength(1)
    expect(reported[0]).not.toBe(raw)
    expect(reported[0]?.cause).toBeUndefined()
    expect(reported[0]?.stack).not.toContain("private-token-and-command")
    expect(JSON.stringify(reported)).not.toContain("private-token-and-command")
  })

  test("rate limits before allocating a sandbox and rejects oversized bodies", async () => {
    let sandboxes = 0
    const keys: string[] = []
    const token = await capability()
    const limited = environment()
    limited.MONGOLGPT_RUNTIME_BURST_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key)
        return { success: false }
      },
    }
    const handler = createRuntimeHandler<Environment>({
      sandbox: () => {
        sandboxes += 1
        return sandbox().value
      },
    })

    const rateLimited = await handler(
      hostedRequest("/session", { headers: { authorization: `Bearer ${token}` } }),
      limited,
    )
    expect(rateLimited.status).toBe(429)
    expect(rateLimited.headers.get("retry-after")).toBe("60")
    expect(keys).toEqual(["account:acc_123"])
    expect(sandboxes).toBe(0)

    const oversized = await handler(
      hostedRequest("/session", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-length": String(16 * 1024 * 1024 + 1) },
        body: "x",
      }),
      environment(),
    )
    expect(oversized.status).toBe(413)
    expect(sandboxes).toBe(0)
  })
})

describe("runtime account and path isolation", () => {
  test("derives stable but separate sandbox and password identities", async () => {
    const first = await deriveRuntimeIdentity("acc_123", "wrk_123", secret)
    const repeated = await deriveRuntimeIdentity("acc_123", "wrk_123", secret)
    const otherAccount = await deriveRuntimeIdentity("acc_456", "wrk_123", secret)
    const otherWorkspace = await deriveRuntimeIdentity("acc_123", "wrk_456", secret)

    expect(first).toEqual(repeated)
    expect(first.sandboxID).not.toBe(otherAccount.sandboxID)
    expect(first.password).not.toBe(otherAccount.password)
    expect(first.sandboxID).not.toBe(otherWorkspace.sandboxID)
    expect(first.password).not.toBe(otherWorkspace.password)
    expect(first.sandboxID).not.toContain("acc_123")
    expect(first.sandboxID).not.toContain("wrk_123")
  })

  test("confines directories to the account workspace", () => {
    expect(hostedDirectory(null)).toBe("/workspace")
    expect(hostedDirectory("/")).toBe("/workspace")
    expect(hostedDirectory("projects/demo")).toBe("/workspace/projects/demo")
    expect(hostedDirectory(encodeURIComponent("/workspace/projects/demo"))).toBe("/workspace/projects/demo")
    expect(hostedDirectory("/etc")).toBeNull()
    expect(hostedDirectory("../other-account")).toBeNull()
    expect(hostedDirectory("projects/../../other-account")).toBeNull()
  })
})

type StarterProcess = {
  readonly id: string
  readonly status: string
}

describe("runtime process singleflight", () => {
  test("shares one runtime process start across concurrent callers", async () => {
    const process = { id: RUNTIME_PROCESS_ID, status: "running" } satisfies StarterProcess
    const started = deferred<StarterProcess>()
    const startRuntime = createRuntimeProcessStarter<StarterProcess>(async () => null)
    let starts = 0

    const calls = Array.from({ length: 5 }, () =>
      startRuntime(async () => {
        starts += 1
        return started.promise
      }),
    )
    await Promise.resolve()
    expect(starts).toBe(1)
    started.resolve(process)

    await expect(Promise.all(calls)).resolves.toEqual([process, process, process, process, process])
    expect(starts).toBe(1)
  })

  test("uses a fresh lookup after pending work settles", async () => {
    const first = { id: RUNTIME_PROCESS_ID, status: "running" } satisfies StarterProcess
    const second = { id: RUNTIME_PROCESS_ID, status: "running" } satisfies StarterProcess
    const lookups: Array<StarterProcess | null> = [null, second]
    const startRuntime = createRuntimeProcessStarter<StarterProcess>(async () => lookups.shift() ?? null)
    let starts = 0

    await expect(
      startRuntime(async () => {
        starts += 1
        return first
      }),
    ).resolves.toBe(first)
    await expect(
      startRuntime(async () => {
        starts += 1
        return { id: RUNTIME_PROCESS_ID, status: "running" }
      }),
    ).resolves.toBe(second)
    expect(starts).toBe(1)
  })

  test("reuses a warm starting or running process from lookup", async () => {
    for (const status of ["starting", "running"]) {
      const existing = { id: RUNTIME_PROCESS_ID, status } satisfies StarterProcess
      const startRuntime = createRuntimeProcessStarter<StarterProcess>(async () => existing)
      let starts = 0

      await expect(
        startRuntime(async () => {
          starts += 1
          return { id: RUNTIME_PROCESS_ID, status: "running" }
        }),
      ).resolves.toBe(existing)
      expect(starts).toBe(0)
    }
  })

  test("restarts instead of accepting terminal lookup records", async () => {
    for (const status of ["completed", "failed", "killed", "error"]) {
      const replacement = { id: RUNTIME_PROCESS_ID, status: "running" } satisfies StarterProcess
      const startRuntime = createRuntimeProcessStarter<StarterProcess>(async () => ({ id: RUNTIME_PROCESS_ID, status }))
      let starts = 0

      await expect(
        startRuntime(async () => {
          starts += 1
          return replacement
        }),
      ).resolves.toBe(replacement)
      expect(starts).toBe(1)
    }
  })

  test("clears failed starts so later callers can retry", async () => {
    const startRuntime = createRuntimeProcessStarter<StarterProcess>(async () => null)
    let starts = 0

    await expect(
      startRuntime(async () => {
        starts += 1
        throw new Error("first start failed")
      }),
    ).rejects.toThrow("first start failed")
    await expect(
      startRuntime(async () => {
        starts += 1
        return { id: RUNTIME_PROCESS_ID, status: "running" }
      }),
    ).resolves.toEqual({ id: RUNTIME_PROCESS_ID, status: "running" })
    expect(starts).toBe(2)
  })

  test("keeps independent runtime process starters isolated", async () => {
    const first = createRuntimeProcessStarter<StarterProcess>(async () => null)
    const second = createRuntimeProcessStarter<StarterProcess>(async () => null)
    let firstStarts = 0
    let secondStarts = 0

    await expect(
      Promise.all([
        first(async () => {
          firstStarts += 1
          return { id: RUNTIME_PROCESS_ID, status: "running" }
        }),
        second(async () => {
          secondStarts += 1
          return { id: RUNTIME_PROCESS_ID, status: "running" }
        }),
      ]),
    ).resolves.toEqual([
      { id: RUNTIME_PROCESS_ID, status: "running" },
      { id: RUNTIME_PROCESS_ID, status: "running" },
    ])
    expect(firstStarts).toBe(1)
    expect(secondStarts).toBe(1)
  })

  test("rejects concurrent callers with the same start error and then retries", async () => {
    const startRuntime = createRuntimeProcessStarter<StarterProcess>(async () => null)
    const firstError = new Error("start failed")
    let starts = 0

    const calls = Array.from({ length: 5 }, () =>
      startRuntime(async () => {
        starts += 1
        throw firstError
      }),
    )
    await expect(Promise.all(calls)).rejects.toBe(firstError)
    await Promise.all(calls.map((call) => expect(call).rejects.toBe(firstError)))
    expect(starts).toBe(1)

    await expect(
      startRuntime(async () => {
        starts += 1
        return { id: RUNTIME_PROCESS_ID, status: "running" }
      }),
    ).resolves.toEqual({ id: RUNTIME_PROCESS_ID, status: "running" })
    expect(starts).toBe(2)
  })

  test("clears failed lookups so later callers can retry", async () => {
    const lookupError = new Error("lookup failed")
    const lookups: Array<"throw" | StarterProcess | null> = ["throw", null]
    const startRuntime = createRuntimeProcessStarter<StarterProcess>(async () => {
      const next = lookups.shift()
      if (next === "throw") throw lookupError
      return next ?? null
    })
    let starts = 0

    await expect(
      startRuntime(async () => {
        starts += 1
        return { id: RUNTIME_PROCESS_ID, status: "running" }
      }),
    ).rejects.toBe(lookupError)
    expect(starts).toBe(0)

    await expect(
      startRuntime(async () => {
        starts += 1
        return { id: RUNTIME_PROCESS_ID, status: "running" }
      }),
    ).resolves.toEqual({ id: RUNTIME_PROCESS_ID, status: "running" })
    expect(starts).toBe(1)
  })
})

describe("runtime deployment contract", () => {
  test("keeps RPC transport while singleflighting only the fixed runtime process", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
    expect(source).toContain('transport: "rpc"')
    expect(source).toContain("createRuntimeProcessStarter")
    expect(source).toContain("#startRuntimeProcess")
    expect(source).toContain("options?.processId !== RUNTIME_PROCESS_ID")
    expect(source).toContain("return super.startProcess(...args)")
  })

  test("enables HTTPS interception while preserving restricted egress policy", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
    expect(source).toContain("enableInternet = false")
    expect(source).toContain("interceptHttps = true")
    expect(source).toContain('allowedHosts = ["*"]')
    expect(source).toContain("deniedHosts = blockedEgressHosts")
    expect(source).toContain("export { ContainerProxy }")
  })

  test("pins matching sandbox SDK and container image versions", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
    const version = manifest.dependencies["@cloudflare/sandbox"]
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    const dockerfile = await Bun.file(new URL("../Dockerfile", import.meta.url)).text()
    const stages = dockerfile.split(/\r?\n/).filter((line) => /^FROM\s/i.test(line))
    expect(stages).toHaveLength(2)
    expect(stages[0]).toMatch(/^FROM docker\.io\/alpine:3\.23@sha256:[0-9a-f]{64} AS workspace-launcher$/)
    expect(stages.at(-1)).toBe(`FROM docker.io/cloudflare/sandbox:${version}`)
    expect(dockerfile).toContain(
      "COPY --from=workspace-launcher --chmod=0755 /workspace-launcher /usr/local/bin/mongolgpt-workspace-launcher",
    )
    expect(dockerfile).toContain("tini-static=0.19.0-r3")
    expect(dockerfile).toContain(
      "COPY --from=workspace-launcher --chmod=0755 /sbin/tini-static /usr/local/bin/mongolgpt-init",
    )
    expect(dockerfile).toContain("ENV MONGOLGPT_CONTAINER_ENTRYPOINT=true")
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/usr/local/bin/mongolgpt-init", "--", "/usr/local/bin/mongolgpt", "serve"]',
    )
    expect(dockerfile).toContain("COPY container/licenses/tini.LICENSE /usr/share/licenses/mongolgpt-init/LICENSE")
    const sdk = await Bun.file(new URL("../package.json", import.meta.resolve("@cloudflare/sandbox"))).json()
    expect(sdk.version).toBe(version)
    const root = await Bun.file(new URL("../../../package.json", import.meta.url)).json()
    expect(root.workspaces.catalog.hono).toBe(root.overrides.hono)
    expect(Bun.semver.satisfies(root.overrides.hono, sdk.dependencies.hono)).toBe(true)
  })

  test("requires both runtime secrets and deploys the restricted sandbox in every stage", async () => {
    const packageJSON = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as {
      scripts?: Record<string, unknown>
      version?: unknown
    }
    expect(typeof packageJSON.version).toBe("string")
    if (typeof packageJSON.version !== "string") throw new Error("runtime package version must be a string")

    for (const stage of ["dev", "production"] as const) {
      const parsed: unknown = Bun.JSONC.parse(
        await Bun.file(new URL(`../wrangler.${stage}.jsonc`, import.meta.url)).text(),
      )
      if (
        !record(parsed) ||
        !record(parsed.secrets) ||
        !Array.isArray(parsed.ratelimits) ||
        !Array.isArray(parsed.containers) ||
        !record(parsed.durable_objects) ||
        !Array.isArray(parsed.durable_objects.bindings)
      ) {
        throw new Error(`wrangler.${stage}.jsonc must contain runtime deployment settings`)
      }
      expect(parsed.secrets.required).toEqual(["MONGOLGPT_RUNTIME_SECRET", "MONGOLGPT_RUNTIME_AUTH_SECRET"])
      expect(parsed.ratelimits).toEqual([
        expect.objectContaining({
          name: "MONGOLGPT_RUNTIME_BURST_LIMITER",
          simple: { limit: 60, period: 10 },
        }),
        expect.objectContaining({
          name: "MONGOLGPT_RUNTIME_RATE_LIMITER",
          simple: { limit: 300, period: 60 },
        }),
      ])
      expect(parsed.containers).toEqual([
        expect.objectContaining({
          class_name: "MongolGPTSandbox",
          instance_type: "basic",
          max_instances: 5,
        }),
      ])
      expect(record(parsed.durable_objects.bindings[0]) && parsed.durable_objects.bindings[0].class_name).toBe(
        "MongolGPTSandbox",
      )

      expect(parsed.name).toBe(stage === "dev" ? "mongolgpt-runtime-dev" : "mongolgpt-runtime-production")
      expect(parsed).not.toHaveProperty("routes")
      expect(parsed).not.toHaveProperty("vars")

      const command = createRuntimeDeployCommand({
        stage,
        rootDomain: "mgpt.mn",
        version: packageJSON.version,
        args: ["--dry-run"],
        bunExecutable: "bun",
      })
      expect(command.slice(0, 4)).toEqual(["bun", "x", "wrangler", "deploy"])
      expect(command).toContain("--dry-run")
      expect(command.find((value) => value.startsWith("--config="))).toEndWith(`wrangler.${stage}.jsonc`)
      const stageDomain = stage === "dev" ? "dev.mgpt.mn" : "mgpt.mn"
      expect(command.slice(-10)).toEqual([
        "--domain",
        `runtime.${stageDomain}`,
        "--var",
        `MONGOLGPT_RUNTIME_VERSION:${packageJSON.version}`,
        "--var",
        `MONGOLGPT_APP_ORIGIN:https://app.${stageDomain}`,
        "--var",
        `MONGOLGPT_CONSOLE_URL:https://${stageDomain}`,
        "--var",
        `STAGE:${stage}`,
      ])
    }

    expect(packageJSON.scripts?.["deploy:dev"]).toBe("bun script/deploy.ts dev")
    expect(packageJSON.scripts?.["deploy:production"]).toBe("bun script/deploy.ts production")
    expect(parseRuntimeDeployStage("dev")).toBe("dev")
    expect(parseRuntimeDeployStage("production")).toBe("production")
    expect(() => parseRuntimeDeployStage("staging")).toThrow()
    expect(() => createRuntimeDeployCommand({ stage: "dev", rootDomain: "mgpt.mn", version: " " })).toThrow()
    expect(() => createRuntimeDeployCommand({ stage: "dev", rootDomain: "MGPT.MN", version: "0.1.1" })).toThrow()
  })
})
