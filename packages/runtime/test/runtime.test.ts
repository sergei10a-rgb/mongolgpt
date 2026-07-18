import { describe, expect, test } from "bun:test"
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
const secret = "runtime-secret-that-is-longer-than-thirty-two-characters"

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
    MONGOLGPT_CONSOLE_ORIGIN: consoleOrigin,
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

function session(account = { id: "acc_123", email: "user@example.com" }) {
  return Response.json({
    account: {
      [account.id]: account,
    },
    current: account.id,
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

function sandbox(input: { existing?: RuntimeProcess | null; response?: Response } = {}) {
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
        return new Response("websocket")
      },
    } satisfies RuntimeSandbox,
  }
}

function hostedRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("origin", appOrigin)
  headers.set("cookie", "theme=dark; auth=session-value; analytics=1")
  return new Request(`https://runtime.dev.mgpt.mn${path}`, {
    ...init,
    headers,
  })
}

describe("MongolGPT Cloudflare runtime", () => {
  test("reports a configured JSON health contract without starting a sandbox", async () => {
    let sandboxes = 0
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => {
        throw new Error("auth should not run")
      },
      sandbox: () => {
        sandboxes += 1
        return sandbox().value
      },
    })

    const response = await handler(
      new Request("https://runtime.dev.mgpt.mn/global/health", {
        headers: { origin: appOrigin },
      }),
      environment(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body: unknown = await response.json()
    expect(body).toEqual({
      healthy: true,
      service: "mongolgpt-runtime",
      stage: "dev",
      version: "test",
    })
    expect(sandboxes).toBe(0)
  })

  test("fails health when a required secret is absent", async () => {
    const env = environment()
    env.MONGOLGPT_RUNTIME_SECRET = ""
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => session(),
      sandbox: () => sandbox().value,
    })

    const response = await handler(new Request("https://runtime.dev.mgpt.mn/global/health"), env)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ healthy: false })
  })

  test("answers strict credentialed CORS preflight without authenticating", async () => {
    let authCalls = 0
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => {
        authCalls += 1
        return session()
      },
      sandbox: () => sandbox().value,
    })

    const response = await handler(
      hostedRequest("/session", {
        method: "OPTIONS",
        headers: {
          "access-control-request-method": "GET",
        },
      }),
      environment(),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(authCalls).toBe(0)
  })

  test("rejects protected requests from every origin except the hosted app", async () => {
    let authCalls = 0
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => {
        authCalls += 1
        return session()
      },
      sandbox: () => sandbox().value,
    })
    const request = new Request("https://runtime.dev.mgpt.mn/session", {
      headers: {
        cookie: "auth=session-value",
        origin: "https://attacker.example",
      },
    })

    const response = await handler(request, environment())

    expect(response.status).toBe(403)
    expect(authCalls).toBe(0)
  })

  test("returns the hosted account session and forwards only the auth cookie", async () => {
    const authRequests: Request[] = []
    const handler = createRuntimeHandler<Environment>({
      fetch: async (request) => {
        authRequests.push(request)
        return session()
      },
      sandbox: () => sandbox().value,
    })

    const response = await handler(hostedRequest("/auth/session"), environment())

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin)
    const body: unknown = await response.json()
    expect(body).toEqual({
      authenticated: true,
      account: {
        id: "acc_123",
        email: "user@example.com",
      },
    })
    expect(authRequests).toHaveLength(1)
    expect(authRequests[0]?.url).toBe(`${consoleOrigin}/auth/status`)
    expect(authRequests[0]?.headers.get("cookie")).toBe("auth=session-value")
  })

  test("starts an account-isolated server and proxies with internal credentials", async () => {
    const runtime = sandbox()
    const ids: string[] = []
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => session(),
      sandbox: (_env, id) => {
        ids.push(id)
        return runtime.value
      },
    })

    const response = await handler(
      hostedRequest("/session", {
        method: "POST",
        headers: {
          authorization: "Bearer attacker-controlled",
          "content-type": "application/json",
          "x-mongolgpt-directory": encodeURIComponent("projects/demo"),
        },
        body: "{}",
      }),
      environment(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin)
    expect(ids).toHaveLength(1)
    expect(ids[0]).toStartWith("account-")
    expect(ids[0]).not.toContain("acc_123")
    expect(runtime.started).toHaveLength(1)
    expect(runtime.started[0]?.command).toBe("/usr/local/bin/mongolgpt serve --hostname 0.0.0.0 --port 4096")
    expect(runtime.started[0]?.options.cwd).toBe("/workspace")
    expect(runtime.started[0]?.options.env.MONGOLGPT_SERVER_PASSWORD).toHaveLength(43)
    expect(runtime.requests).toHaveLength(1)
    expect(runtime.requests[0]?.headers.get("cookie")).toBeNull()
    expect(runtime.requests[0]?.headers.get("origin")).toBeNull()
    expect(runtime.requests[0]?.headers.get("authorization")).toStartWith("Basic ")
    expect(runtime.requests[0]?.headers.get("authorization")).not.toContain("attacker-controlled")
    expect(decodeURIComponent(runtime.requests[0]?.headers.get("x-mongolgpt-directory") ?? "")).toBe(
      "/workspace/projects/demo",
    )
  })

  test("rate limits an authenticated account before allocating a sandbox", async () => {
    let sandboxes = 0
    const keys: string[] = []
    const env = environment()
    env.MONGOLGPT_RUNTIME_BURST_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key)
        return { success: false }
      },
    }
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => session(),
      sandbox: () => {
        sandboxes += 1
        return sandbox().value
      },
    })

    const response = await handler(hostedRequest("/session"), env)

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("60")
    expect(keys).toEqual(["account:acc_123"])
    expect(sandboxes).toBe(0)
  })

  test("rejects oversized request bodies before allocating a sandbox", async () => {
    let sandboxes = 0
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => session(),
      sandbox: () => {
        sandboxes += 1
        return sandbox().value
      },
    })

    const response = await handler(
      hostedRequest("/session", {
        method: "POST",
        headers: {
          "content-length": String(16 * 1024 * 1024 + 1),
        },
        body: "x",
      }),
      environment(),
    )

    expect(response.status).toBe(413)
    expect(sandboxes).toBe(0)
  })

  test("reuses a healthy server process instead of starting another", async () => {
    const running = process()
    const runtime = sandbox({ existing: running.value })
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => session(),
      sandbox: () => runtime.value,
    })

    const response = await handler(hostedRequest("/project"), environment())

    expect(response.status).toBe(200)
    expect(runtime.started).toHaveLength(0)
    expect(running.ports).toEqual([4096])
  })

  test("routes websocket upgrades through the authenticated sandbox", async () => {
    const runtime = sandbox()
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => session(),
      sandbox: () => runtime.value,
    })

    const response = await handler(
      hostedRequest("/pty/pty_123/connect", {
        headers: {
          upgrade: "websocket",
        },
      }),
      environment(),
    )

    expect(await response.text()).toBe("websocket")
    expect(runtime.websocket).toHaveLength(1)
    expect(runtime.requests).toHaveLength(0)
  })

  test("does not turn an unavailable auth service into a fake login state", async () => {
    const handler = createRuntimeHandler<Environment>({
      fetch: async () => new Response("<html>fallback</html>", { headers: { "content-type": "text/html" } }),
      sandbox: () => sandbox().value,
    })

    const response = await handler(hostedRequest("/auth/session"), environment())

    expect(response.status).toBe(503)
    const body: unknown = await response.json()
    expect(body).toEqual({
      error: "Нэвтрэлтийн үйлчилгээнд түр холбогдож чадсангүй.",
    })
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
  test("requires its secret, rate limits accounts, and deploys the restricted sandbox in every stage", async () => {
    for (const stage of ["dev", "production"]) {
      const parsed: unknown = JSON.parse(
        await Bun.file(new URL(`../wrangler.${stage}.jsonc`, import.meta.url)).text(),
      )
      if (!record(parsed)) throw new Error(`wrangler.${stage}.jsonc must contain an object`)
      const config = parsed
      const secrets = record(config.secrets) ? config.secrets : {}
      const durableObjects = record(config.durable_objects) ? config.durable_objects : {}
      const bindings = Array.isArray(durableObjects.bindings) ? durableObjects.bindings : []
      const binding = record(bindings[0]) ? bindings[0] : {}

      expect(secrets.required).toEqual(["MONGOLGPT_RUNTIME_SECRET"])
      expect(config.ratelimits).toEqual([
        expect.objectContaining({
          name: "MONGOLGPT_RUNTIME_BURST_LIMITER",
          simple: { limit: 60, period: 10 },
        }),
        expect.objectContaining({
          name: "MONGOLGPT_RUNTIME_RATE_LIMITER",
          simple: { limit: 300, period: 60 },
        }),
      ])
      expect(config.containers).toEqual([
        expect.objectContaining({
          class_name: "MongolGPTSandbox",
          instance_type: "basic",
          max_instances: 5,
        }),
      ])
      expect(binding.class_name).toBe("MongolGPTSandbox")
    }
  })
})
