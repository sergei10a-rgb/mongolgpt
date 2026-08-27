import { describe, expect, test } from "bun:test"
import { issueRuntimeCapability, runtimeGatewayHeader, verifyRuntimeCapability } from "@mongolgpt/runtime-auth"
import { createRuntimeDeployCommand, parseRuntimeDeployStage } from "../script/deploy"
import {
  createRuntimeHandler,
  deriveRuntimeIdentity,
  hostedDirectory,
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

describe("MongolGPT Cloudflare runtime", () => {
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
    expect(sessionBody).toMatchObject({ authenticated: true, account: { id: "acc_123" } })

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

  test("starts an account-isolated server and proxies with internal credentials", async () => {
    const runtime = sandbox()
    const ids: string[] = []
    const handler = createRuntimeHandler<Environment>({
      sandbox: (_env, id) => {
        ids.push(id)
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
          [runtimeGatewayHeader]: "browser-controlled-value",
        },
        body: "{}",
      }),
      environment(),
    )

    expect(response.status).toBe(200)
    expect(ids[0]).toStartWith("account-")
    expect(ids[0]).not.toContain("acc_123")
    expect(runtime.started).toHaveLength(1)
    expect(runtime.started[0]?.options.env.MONGOLGPT_SERVER_PASSWORD).toHaveLength(43)
    expect(runtime.started[0]?.options.env).toMatchObject({
      MONGOLGPT_RUNTIME_MODE: "hosted",
      MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
      MONGOLGPT_CONSOLE_URL: consoleOrigin,
      MONGOLGPT_API_KEY: "runtime",
    })
    expect(Object.values(runtime.started[0]?.options.env ?? {})).not.toContain(token)
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
    expect(gateway).toMatchObject({ sub: "acc_123", authVersion: 1, aud: consoleOrigin })
    expect(decodeURIComponent(runtime.requests[0]?.headers.get("x-mongolgpt-directory") ?? "")).toBe(
      "/workspace/projects/demo",
    )
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
    const first = await deriveRuntimeIdentity("acc_123", secret)
    const repeated = await deriveRuntimeIdentity("acc_123", secret)
    const other = await deriveRuntimeIdentity("acc_456", secret)

    expect(first).toEqual(repeated)
    expect(first.sandboxID).not.toBe(other.sandboxID)
    expect(first.password).not.toBe(other.password)
    expect(first.sandboxID).not.toContain("acc_123")
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

describe("runtime deployment contract", () => {
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
      expect(parsed.vars).toEqual(
        expect.objectContaining({
          MONGOLGPT_APP_ORIGIN: stage === "dev" ? appOrigin : "https://app.mgpt.mn",
          MONGOLGPT_CONSOLE_URL: stage === "dev" ? consoleOrigin : "https://mgpt.mn",
          STAGE: stage,
        }),
      )
      expect(parsed.vars).not.toHaveProperty("MONGOLGPT_RUNTIME_VERSION")

      const command = createRuntimeDeployCommand({
        stage,
        version: packageJSON.version,
        args: ["--dry-run"],
        bunExecutable: "bun",
      })
      expect(command.slice(0, 4)).toEqual(["bun", "x", "wrangler", "deploy"])
      expect(command).toContain("--dry-run")
      expect(command.at(-2)).toBe("--var")
      expect(command.at(-1)).toBe(`MONGOLGPT_RUNTIME_VERSION:${packageJSON.version}`)
      expect(command.find((value) => value.startsWith("--config="))).toEndWith(`wrangler.${stage}.jsonc`)
      if (stage === "dev") {
        expect(parsed.routes).toEqual([{ pattern: "runtime.dev.mgpt.mn", custom_domain: true }])
      }
    }

    expect(packageJSON.scripts?.["deploy:dev"]).toBe("bun script/deploy.ts dev")
    expect(packageJSON.scripts?.["deploy:production"]).toBe("bun script/deploy.ts production")
    expect(parseRuntimeDeployStage("dev")).toBe("dev")
    expect(parseRuntimeDeployStage("production")).toBe("production")
    expect(() => parseRuntimeDeployStage("staging")).toThrow()
    expect(() => createRuntimeDeployCommand({ stage: "dev", version: " " })).toThrow()
  })
})
