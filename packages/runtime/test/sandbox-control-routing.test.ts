import { describe, expect, mock, test } from "bun:test"
import { dirname, join } from "node:path"
import { issueRuntimeCapability } from "@mongolgpt/runtime-auth"
import { deriveRuntimeIdentity } from "../src/runtime"
import {
  checkpointControlHeader,
  deriveControlToken,
  sdkControlEnv,
  sdkControlHeader,
} from "@mongolgpt/runtime-auth/control"

mock.module("cloudflare:workers", () => {
  class DurableObject<Env = unknown> {
    constructor(
      readonly ctx: unknown,
      readonly env: Env,
    ) {}
  }

  class WorkerEntrypoint<Env = unknown, Props = unknown> {
    constructor(
      readonly ctx: { props: Props },
      readonly env: Env,
    ) {}
  }

  class RpcTarget {}

  return {
    DurableObject,
    RpcTarget,
    WorkerEntrypoint,
    tracing: {
      enterSpan<T>(_name: string, fn: (span: { setAttribute(key: string, value: unknown): void }) => T): T {
        return fn({ setAttribute() {} })
      },
    },
  }
})

const runtimeSecret = "sandbox-control-routing-secret-at-least-thirty-two-characters"
const sandboxID = "root-supervisor-sandbox"
const { MongolGPTSandbox } = await import("../src/index")
const { CanarySandbox, canaryScope } = await import("./fixtures/cloudflare-canary")

describe("sandbox control routing", () => {
  test("retirement seals the actual SDK subclass, stops its container and survives re-instantiation", async () => {
    const marker = { accountID: "acc_stop", workspaceID: "wrk_stop", requestID: "del_stop" }
    const identity = await deriveRuntimeIdentity(marker.accountID, marker.workspaceID, runtimeSecret)
    const fixture = await createSandbox({
      Sandbox: {
        idFromName: (id: string) => ({ toString: () => (id === identity.sandboxID ? sandboxID : "different-sandbox") }),
      } as RuntimeEnv["Sandbox"],
      HISTORY: {
        prepare: () => ({ bind: () => ({ first: async () => ({ account_id: marker.accountID }) }) }),
      } as unknown as D1Database,
    })
    await expect(fixture.sandbox.retireAccount({ ...marker, workspaceID: "wrk_wrong" })).rejects.toThrow("хүрээ")
    expect(fixture.ctx.container?.running).toBe(true)
    expect(await bounded(fixture.sandbox.retireAccount(marker))).toEqual({ ...marker, stopped: true })
    expect(fixture.ctx.container?.running).toBe(false)
    const calls = fixture.calls.length
    const restarted = new MongolGPTSandbox(fixture.ctx, fixture.env)
    await fixture.ctx.flush()
    for (const sandbox of [fixture.sandbox, restarted]) {
      for (const operation of [
        () => sandbox.start(),
        () => sandbox.startAndWaitForPorts([4096]),
        () => sandbox.startProcess("must-not-run"),
        () => sandbox.onStart(),
        () => sandbox.probeReadiness("synthetic-password", true, 100),
        () => sandbox.fetch(new Request("http://sandbox/")),
        () => sandbox.containerFetch(new Request("http://sandbox/"), 4096),
        () => sandbox.wsConnect(new Request("http://sandbox/", { headers: { upgrade: "websocket" } }), 4096),
      ])
        await expect(bounded<unknown>(operation())).rejects.toThrow("хаагдсан")
      expect(await bounded(sandbox.retireAccount(marker))).toEqual({ ...marker, stopped: true })
    }
    expect(fixture.calls).toHaveLength(calls)
    expect(fixture.starts).toEqual([])
  })

  test("retirement refuses an account without the prior global D1 fence", async () => {
    const marker = { accountID: "acc_stop", workspaceID: "wrk_stop", requestID: "del_stop" }
    const fixture = await createSandbox({
      Sandbox: { idFromName: () => ({ toString: () => sandboxID }) } as unknown as RuntimeEnv["Sandbox"],
      HISTORY: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database,
    })
    await expect(fixture.sandbox.retireAccount(marker)).rejects.toThrow("эхлээгүй")
    expect(fixture.ctx.container?.running).toBe(true)
    await bounded(fixture.sandbox.containerFetch(new Request("http://sandbox/api/manual"), 3000))
    expect(fixture.calls.length).toBeGreaterThan(0)
  })

  test("a failed stop acknowledgement keeps admission sealed and is retryable", async () => {
    const marker = { accountID: "acc_stop", workspaceID: "wrk_stop", requestID: "del_stop" }
    const fixture = await createSandbox(retiredEnvironment(marker.accountID))
    const container = fixture.ctx.container!
    const destroy = container.destroy.bind(container)
    let attempts = 0
    container.destroy = async () => {
      await destroy()
      if (++attempts === 1) throw new Error("lost stop acknowledgement")
    }
    await expect(bounded(fixture.sandbox.retireAccount(marker))).rejects.toThrow("lost stop acknowledgement")
    await expect(fixture.sandbox.start()).rejects.toThrow("хаагдсан")
    expect(await bounded(fixture.sandbox.retireAccount(marker))).toEqual({ ...marker, stopped: true })
    expect(container.running).toBe(false)
    expect(attempts).toBe(2)
  })

  test("a platform acknowledgement without termination cannot produce a stopped receipt", async () => {
    const marker = { accountID: "acc_stop", workspaceID: "wrk_stop", requestID: "del_stop" }
    const fixture = await createSandbox(retiredEnvironment(marker.accountID))
    fixture.ctx.container!.destroy = async () => {}
    await expect(bounded(fixture.sandbox.retireAccount(marker))).rejects.toThrow("баталгаажуулж чадсангүй")
    await expect(fixture.sandbox.startProcess("must-not-run")).rejects.toThrow("хаагдсан")
    expect(fixture.ctx.container!.running).toBe(true)
  })

  test("concurrent retirement drains pre-admitted work and stops a late platform start again", async () => {
    const marker = { accountID: "acc_stop", workspaceID: "wrk_stop", requestID: "del_stop" }
    const validated = Promise.withResolvers<void>()
    let validations = 0
    const fixture = await createSandbox({
      ...retiredEnvironment(marker.accountID),
      HISTORY: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              if (++validations === 2) validated.resolve()
              // Both asynchronous identity checks must finish before testing
              // overlapping stops, otherwise the second call is a later retry.
              await validated.promise
              return { account_id: marker.accountID }
            },
          }),
        }),
      } as unknown as D1Database,
    })
    const container = fixture.ctx.container!
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    const getPort = container.getTcpPort.bind(container)
    const destroy = container.destroy.bind(container)
    let stops = 0
    let acknowledged = false
    container.getTcpPort = (port) => ({
      ...getPort(port),
      async fetch() {
        entered.resolve()
        await release.promise
        // Simulate a platform start that was already admitted before sealing.
        container.start()
        return response(null, { status: 204 })
      },
    })
    container.destroy = async () => {
      stops++
      await destroy()
      stopped.resolve()
    }
    const fetching = fixture.sandbox.containerFetch(new Request("http://sandbox/admitted"), 4096)
    await bounded(entered.promise)
    const retiring = Promise.all([fixture.sandbox.retireAccount(marker), fixture.sandbox.retireAccount(marker)]).then(
      (result) => {
        acknowledged = true
        return result
      },
    )
    await bounded(stopped.promise)
    expect(acknowledged).toBe(false)
    await expect(fixture.sandbox.start()).rejects.toThrow("хаагдсан")
    release.resolve()
    expect((await bounded(fetching)).status).toBe(204)
    expect(await bounded(retiring)).toEqual([
      { ...marker, stopped: true },
      { ...marker, stopped: true },
    ])
    expect(stops).toBe(2)
    expect(container.running).toBe(false)
  })

  test("a concurrent caller validated after the first stop rechecks termination without reopening admission", async () => {
    const marker = { accountID: "acc_stop", workspaceID: "wrk_stop", requestID: "del_stop" }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let validations = 0
    const fixture = await createSandbox({
      ...retiredEnvironment(marker.accountID),
      HISTORY: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              if (++validations === 2) {
                entered.resolve()
                await release.promise
              }
              return { account_id: marker.accountID }
            },
          }),
        }),
      } as unknown as D1Database,
    })
    const container = fixture.ctx.container!
    const destroy = container.destroy.bind(container)
    const stops: boolean[] = []
    container.destroy = async () => {
      stops.push(container.running)
      await destroy()
    }
    const retiring = [fixture.sandbox.retireAccount(marker), fixture.sandbox.retireAccount(marker)]
    try {
      await bounded(entered.promise)
      expect(await bounded(Promise.race(retiring))).toEqual({ ...marker, stopped: true })
      expect(container.running).toBe(false)
      await expect(fixture.sandbox.start()).rejects.toThrow("хаагдсан")
    } finally {
      release.resolve()
    }
    expect(await bounded(Promise.all(retiring))).toEqual([
      { ...marker, stopped: true },
      { ...marker, stopped: true },
    ])
    expect(stops).toEqual([true, false])
    expect(container.running).toBe(false)
    expect(fixture.starts).toEqual([])
  })

  for (const state of ["retired", "unavailable", "active"] as const) {
    test(`the actual Worker checks ${state} account admission before allocating a sandbox`, async () => {
      const entry = await import("../src/index")
      const scope = { accountID: "acc_worker_retirement", workspaceID: "wrk_worker_retirement" }
      const authSecret = "worker-retirement-auth-secret-at-least-thirty-two-characters"
      let allocated = false
      const queries: string[] = []
      const bindings: unknown[][] = []
      const env = {
        MONGOLGPT_APP_ORIGIN: "https://app.dev.mgpt.mn",
        MONGOLGPT_CONSOLE_URL: "https://dev.mgpt.mn",
        MONGOLGPT_RUNTIME_AUTH_SECRET: authSecret,
        MONGOLGPT_RUNTIME_SECRET: runtimeSecret,
        MONGOLGPT_RUNTIME_VERSION: "retirement-test",
        MONGOLGPT_RUNTIME_BURST_LIMITER: limiter(),
        MONGOLGPT_RUNTIME_RATE_LIMITER: limiter(),
        STAGE: "dev",
        Sandbox: new Proxy(
          {},
          {
            get() {
              allocated = true
              throw new Error("test stops at sandbox allocation")
            },
          },
        ),
        HISTORY: {
          prepare(query: string) {
            queries.push(query)
            return {
              bind(...args: unknown[]) {
                bindings.push(args)
                return {}
              },
            }
          },
          async batch() {
            if (state === "unavailable") throw new Error("private D1 failure")
            return [{ success: true, results: state === "retired" ? [{ account_id: scope.accountID }] : [] }]
          },
        },
      } as unknown as RuntimeEnv
      const token = await issueRuntimeCapability({
        ...scope,
        authVersion: 1,
        audience: "https://runtime.dev.mgpt.mn",
        secret: authSecret,
        ttlSeconds: 90,
      })
      const response = await entry.default.fetch(
        new Request("https://runtime.dev.mgpt.mn/project", {
          headers: { origin: env.MONGOLGPT_APP_ORIGIN, authorization: `Bearer ${token}` },
        }) as Parameters<typeof entry.default.fetch>[0],
        env,
      )
      expect(response.status).toBe(502)
      expect(allocated).toBe(state === "active")
      expect(queries.length).toBeGreaterThan(0)
      expect(
        queries.every((query) => query === "SELECT account_id FROM runtime_history_retirement WHERE account_id = ?"),
      ).toBe(true)
      expect(bindings.every((args) => JSON.stringify(args) === JSON.stringify([scope.accountID]))).toBe(true)
      expect(await response.text()).not.toMatch(/private D1|acc_worker|SELECT|test stops/)
    })
  }

  test("pinned SDK invokes onStart again for an already-running container", async () => {
    const fixture = await createSandbox({}, CanarySandbox)
    const canary = fixture.sandbox as InstanceType<typeof CanarySandbox>
    expect((await canary.canaryState()).bootCount).toBe(0)
    await bounded(canary.startAndWaitForPorts([4096]))
    await bounded(canary.startAndWaitForPorts([4096]))
    expect((await canary.canaryState()).bootCount).toBe(2)
    expect(fixture.starts).toHaveLength(0)
  })

  test("runs against the pinned installed Cloudflare sandbox and container packages", async () => {
    const sandboxPackage = await packageJson(Bun.resolveSync("@cloudflare/sandbox/package.json", import.meta.dir))

    expect(sandboxPackage.version).toBe("0.12.9")
    expect((await packageJson(join(dirname(dirname(sandboxPackage.path)), "containers", "package.json"))).version).toBe(
      "0.3.7",
    )
  })

  for (const [SandboxClass, verifiedScope] of [
    [MongolGPTSandbox, { accountID: "account_verified", workspaceID: "wrk_verified" }],
    [CanarySandbox, canaryScope],
  ] as const) {
    test(`${SandboxClass.name} registers both outbound handlers with the verified scope and rejects unknown handlers`, async () => {
      const fixture = await createSandbox({}, SandboxClass)
      const scope = Object.freeze({ ...verifiedScope })
      const history = { method: "history", params: scope }
      const checkpoint = { method: "checkpoint", params: scope }

      await expect(
        fixture.sandbox.setOutboundByHost("history.mongolgpt.internal", "history", scope),
      ).resolves.toBeUndefined()
      expect(fixture.proxyCalls.at(-1)).toMatchObject({
        className: SandboxClass.name,
        containerId: sandboxID,
        outboundByHostOverrides: { "history.mongolgpt.internal": history },
      })

      await expect(
        fixture.sandbox.setOutboundByHost("checkpoint.mongolgpt.internal", "checkpoint", scope),
      ).resolves.toBeUndefined()
      expect(fixture.proxyCalls.at(-1)?.outboundByHostOverrides).toEqual({
        "history.mongolgpt.internal": history,
        "checkpoint.mongolgpt.internal": checkpoint,
      })

      const registrations = fixture.proxyCalls.length
      await expect(fixture.sandbox.setOutboundByHost("history.mongolgpt.internal", "unknown", scope)).rejects.toThrow(
        `Outbound handler method 'unknown' not found in outboundHandlers for ${SandboxClass.name}`,
      )
      expect(fixture.proxyCalls).toHaveLength(registrations)
      expect(fixture.calls).toEqual([])
      expect(fixture.starts).toEqual([])
    })
  }

  test("a getter-only handler map fails the real SDK registry validation", async () => {
    class GetterOnlySandbox extends MongolGPTSandbox {
      static override get outboundHandlers() {
        return MongolGPTSandbox.outboundHandlers
      }
    }

    const fixture = await createSandbox({}, GetterOnlySandbox)
    const registrations = fixture.proxyCalls.length
    for (const handler of ["history", "checkpoint"]) {
      await expect(
        fixture.sandbox.setOutboundByHost(`${handler}.mongolgpt.internal`, handler, canaryScope),
      ).rejects.toThrow(`Outbound handler method '${handler}' not found in outboundHandlers for GetterOnlySandbox`)
    }
    expect(fixture.proxyCalls).toHaveLength(registrations)
    expect(fixture.calls).toEqual([])
    expect(fixture.starts).toEqual([])
  })

  test("injects the SDK control token only on the SDK port and strips untrusted control headers elsewhere", async () => {
    const fixture = await createSandbox()
    const expected = await deriveControlToken(runtimeSecret, sandboxID, "sdk")

    expect(fixture.starts).toEqual([])
    expect(fixture.sandbox.envVars[sdkControlEnv]).toBe(expected)

    await expect(fixture.sandbox.getProcess("process-route-probe")).resolves.toBeNull()
    const callerHeaders = new Headers({
      [sdkControlHeader]: "0".repeat(64),
      [checkpointControlHeader]: "1".repeat(64),
    })
    await fixture.sandbox.containerFetch(
      "https://worker.example/api/manual",
      {
        headers: callerHeaders,
      },
      3000,
    )
    await fixture.sandbox.fetch(
      new Request("https://worker.example/proxy/4096/rpc", {
        headers: {
          [sdkControlHeader]: "2".repeat(64),
          [checkpointControlHeader]: "3".repeat(64),
        },
      }),
    )
    await fixture.sandbox.containerFetch(
      "https://worker.example/rpc",
      {
        headers: {
          [sdkControlHeader]: "4".repeat(64),
          [checkpointControlHeader]: "5".repeat(64),
        },
      },
      5173,
    )

    expect(fixture.calls.map((call) => ({ port: call.port, pathname: new URL(call.url).pathname }))).toEqual([
      { port: 3000, pathname: "/api/process/process-route-probe" },
      { port: 3000, pathname: "/api/manual" },
      { port: 4096, pathname: "/proxy/4096/rpc" },
      { port: 5173, pathname: "/rpc" },
    ])
    expect(fixture.calls.filter((call) => requiresSdkControl(call, expected)).map(unauthorizedCall)).toEqual([])
    expect(fixture.calls[0]!.request.headers.get(sdkControlHeader)).toBe(expected)
    expect(fixture.calls[0]!.request.headers.get(checkpointControlHeader)).toBeNull()
    expect(fixture.calls[0]!.request.redirect).toBe("manual")
    expect(fixture.calls[1]!.request.headers.get(sdkControlHeader)).toBe(expected)
    expect(fixture.calls[1]!.request.headers.get(checkpointControlHeader)).toBeNull()
    expect(callerHeaders.get(sdkControlHeader)).toBe("0".repeat(64))
    expect(callerHeaders.get(checkpointControlHeader)).toBe("1".repeat(64))
    expect(fixture.calls[2]!.request.headers.get(sdkControlHeader)).toBeNull()
    expect(fixture.calls[2]!.request.headers.get(checkpointControlHeader)).toBeNull()
    expect(fixture.calls[3]!.request.headers.get(sdkControlHeader)).toBeNull()
    expect(fixture.calls[3]!.request.headers.get(checkpointControlHeader)).toBeNull()
  })

  test("native HTTP fetch preserves the request while stripping control and routing headers", async () => {
    const { fetchRuntime, runtimeHttpHeader } = await import("../src/runtime-http")
    const fixture = await createSandbox()
    const controller = new AbortController()
    const request = new Request("http://localhost/session?directory=%2Fworkspace", {
      method: "POST",
      headers: {
        authorization: "Basic synthetic-native-credential",
        [runtimeHttpHeader]: "untrusted",
        [sdkControlHeader]: "untrusted-sdk",
        [checkpointControlHeader]: "untrusted-checkpoint",
      },
      body: "synthetic-body",
      signal: controller.signal,
      redirect: "manual",
    })
    await fetchRuntime(fixture.sandbox, request, 4096)
    expect(fixture.calls).toHaveLength(1)
    const forwarded = fixture.calls[0]!
    expect(forwarded.port).toBe(4096)
    expect(forwarded.url).toBe(request.url)
    expect(forwarded.request.method).toBe("POST")
    expect(forwarded.request.headers.get("authorization")).toBe("Basic synthetic-native-credential")
    for (const name of [runtimeHttpHeader, sdkControlHeader, checkpointControlHeader]) {
      expect(forwarded.request.headers.get(name)).toBeNull()
    }
    expect(await forwarded.request.text()).toBe("synthetic-body")
    expect(request.headers.get(runtimeHttpHeader)).toBe("untrusted")
    expect(forwarded.request.redirect).toBe("manual")
    controller.abort()
    expect(forwarded.request.signal.aborted).toBe(true)
    expect(fixture.starts).toEqual([])
  })

  test("routes the real RPC WebSocket upgrade through Sandbox.fetch to /rpc with the SDK token", async () => {
    const fixture = await createSandbox({ SANDBOX_TRANSPORT: "rpc" })
    const expected = await deriveControlToken(runtimeSecret, sandboxID, "sdk")

    await expect(bounded(fixture.sandbox.getProcess("process-route-probe"))).rejects.toThrow(
      /unavailable|torn down|WebSocket upgrade failed/,
    )

    const rpcCall = fixture.calls.find((call) => new URL(call.url).pathname === "/rpc")

    expect(fixture.calls.length).toBeGreaterThanOrEqual(1)
    expect(rpcCall).toBeDefined()
    expect(rpcCall!.port).toBe(3000)
    expect(rpcCall!.request.headers.get("upgrade")).toBe("websocket")
    expect(rpcCall!.request.headers.get("connection")).toBe("Upgrade")
    expect(rpcCall!.request.headers.get(sdkControlHeader)).toBe(expected)
    expect(rpcCall!.request.headers.get(checkpointControlHeader)).toBeNull()
    expect(fixture.calls.filter((call) => requiresSdkControl(call, expected)).map(unauthorizedCall)).toEqual([])
    expect(fixture.starts).toEqual([])
  })

  for (const status of [301, 302, 303, 307, 308]) {
    test(`rejects SDK HTTP ${status} without following the redirect or forwarding its location`, async () => {
      const fixture = await createSandbox({}, MongolGPTSandbox, status)
      await expect(fixture.sandbox.containerFetch("http://worker.example/api/manual", {}, 3000)).rejects.toThrow(
        "SDK control redirects are forbidden",
      )
      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls[0]!.request.redirect).toBe("manual")
      expect(new URL(fixture.calls[0]!.request.url).hostname).toBe("worker.example")
    })
  }
})

type RuntimeSandbox = InstanceType<typeof MongolGPTSandbox>
type RuntimeEnv = ConstructorParameters<typeof MongolGPTSandbox>[1]
type TestRuntimeEnv = RuntimeEnv & { SANDBOX_TRANSPORT?: "http" | "rpc" }
type CapturedFetch = {
  initType: string
  port: number
  request: Request
  tcpHealthProbe: boolean
  url: string
}

type OutboundProxyProps = {
  className: string
  containerId: string
  outboundByHostOverrides?: Record<string, { method: string; params?: unknown }>
}
type FakeContext = DurableObjectState<{}> & { flush(): Promise<void> }
type PackageJson = { path: string; version: string }

function retiredEnvironment(accountID: string): Partial<TestRuntimeEnv> {
  return {
    Sandbox: { idFromName: () => ({ toString: () => sandboxID }) } as unknown as RuntimeEnv["Sandbox"],
    HISTORY: {
      prepare: () => ({ bind: () => ({ first: async () => ({ account_id: accountID }) }) }),
    } as unknown as D1Database,
  }
}

async function createSandbox(
  env: Partial<TestRuntimeEnv> = {},
  SandboxClass = MongolGPTSandbox,
  redirectStatus?: number,
) {
  const calls = new Array<CapturedFetch>()
  const starts = new Array<unknown>()
  const proxyCalls = new Array<OutboundProxyProps>()
  const ctx = fakeContext(fakeContainer(calls, starts, redirectStatus), proxyCalls)
  const runtimeEnv: TestRuntimeEnv = {
    MONGOLGPT_APP_ORIGIN: "https://app.example",
    MONGOLGPT_CONSOLE_URL: "https://console.example",
    MONGOLGPT_RUNTIME_AUTH_SECRET: "runtime-auth-secret-at-least-thirty-two-characters",
    MONGOLGPT_RUNTIME_BURST_LIMITER: limiter(),
    MONGOLGPT_RUNTIME_RATE_LIMITER: limiter(),
    MONGOLGPT_RUNTIME_SECRET: runtimeSecret,
    Sandbox: {} as RuntimeEnv["Sandbox"],
    STAGE: "test",
    ...env,
  }
  const sandbox = new SandboxClass(ctx, runtimeEnv)
  await ctx.flush()
  return { calls, proxyCalls, sandbox, starts, ctx, env: runtimeEnv }
}

function fakeContext(container: ReturnType<typeof fakeContainer>, proxyCalls: OutboundProxyProps[]): FakeContext {
  const values = new Map<string, unknown>([["__CF_CONTAINER_STATE", { status: "healthy", lastChange: Date.now() }]])
  const blockers = new Array<Promise<unknown>>()
  return {
    id: { toString: () => sandboxID },
    container,
    exports: {
      ContainerProxy({ props }: { props: OutboundProxyProps }) {
        proxyCalls.push(structuredClone(props))
        return { fetch: async () => new Response(null, { status: 204 }) }
      },
    },
    storage: {
      kv: {
        get: (key: string) => values.get(key),
        put: (key: string, value: unknown) => {
          values.set(key, value)
        },
        delete: (key: string) => {
          values.delete(key)
        },
      },
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value)
      },
      delete: async (key: string) => {
        values.delete(key)
      },
      setAlarm: async () => {},
      sync: async () => {},
      transaction: async (
        callback: (txn: {
          get(key: string): Promise<unknown>
          put(key: string, value: unknown): Promise<void>
        }) => Promise<void>,
      ) => {
        await callback({
          get: async (key: string) => values.get(key),
          put: async (key: string, value: unknown) => {
            values.set(key, value)
          },
        })
      },
      sql: { exec: () => [] },
    },
    blockConcurrencyWhile(callback: () => Promise<unknown>) {
      const blocker = Promise.resolve().then(callback)
      blockers.push(blocker)
      return blocker
    },
    abort() {},
    async flush() {
      await Promise.all(blockers)
    },
  } as unknown as FakeContext
}

function fakeContainer(calls: CapturedFetch[], starts: unknown[], redirectStatus?: number) {
  let running = true
  return {
    get running() {
      return running
    },
    destroy: async () => {
      running = false
    },
    getTcpPort(port: number) {
      return {
        fetch: async (input: Request | string | URL, init?: RequestInit | Request) => {
          const call = capturedFetch(port, input, init)
          calls.push(call)
          const pathname = new URL(call.url).pathname
          if (redirectStatus && pathname === "/api/manual")
            return response(null, {
              status: redirectStatus,
              headers: { location: "https://untrusted.example/control" },
            })
          if (pathname === "/rpc") return response(null, { status: 400, statusText: "Bad Request" })
          if (pathname.startsWith("/api/process/")) return jsonResponse({ process: null })
          return jsonResponse({})
        },
      }
    },
    interceptOutboundHttp: async () => {},
    interceptOutboundHttps: async () => {},
    interceptAllOutboundHttp: async () => {},
    monitor: () => new Promise<number>(() => {}),
    start: (config: unknown) => {
      running = true
      starts.push(config)
    },
  }
}

function limiter() {
  return { limit: async () => ({ success: true }) }
}

async function packageJson(path: string): Promise<PackageJson> {
  return { ...((await Bun.file(path).json()) as { version: string }), path }
}

function response(body: BodyInit | null, init?: ResponseInit) {
  const value = new Response(body, init)
  Object.defineProperty(value, "webSocket", { value: null })
  return value
}

function jsonResponse(value: unknown) {
  const text = JSON.stringify(value)
  const result = response(null, { headers: { "content-type": "application/json" } })
  Object.defineProperty(result, "json", { value: async () => value })
  Object.defineProperty(result, "text", { value: async () => text })
  return result
}

async function bounded<T>(promise: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("operation hung")), 2000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function capturedFetch(port: number, input: Request | string | URL, init?: RequestInit | Request): CapturedFetch {
  const url = input instanceof Request ? input.url : input.toString()
  const request = input instanceof Request ? input : init instanceof Request ? init : undefined
  return {
    initType: init === undefined ? "undefined" : init instanceof Request ? "Request" : "RequestInit",
    port,
    request: request ?? new Request(url, init),
    tcpHealthProbe: request === undefined && isTcpHealthProbe(url, init),
    url,
  }
}

function isTcpHealthProbe(url: string, init: RequestInit | Request | undefined) {
  return (
    init !== undefined &&
    !(init instanceof Request) &&
    (url === "http://containerstarthealthcheck" || url === "http://ping")
  )
}

function requiresSdkControl(call: CapturedFetch, expected: string) {
  return call.port === 3000 && !call.tcpHealthProbe && call.request.headers.get(sdkControlHeader) !== expected
}

function unauthorizedCall(call: CapturedFetch) {
  return {
    initType: call.initType,
    href: new URL(call.url).href,
    pathname: new URL(call.url).pathname,
    port: call.port,
    sdkPresent: call.request.headers.has(sdkControlHeader),
  }
}
