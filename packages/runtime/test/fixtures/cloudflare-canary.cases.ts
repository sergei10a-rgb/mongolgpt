import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { emptyCanaryDiagnostics, sanitizeCanaryDiagnostics } from "../../script/canary-diagnostics"
import { startupDiagnosticEnv } from "@mongolgpt/runtime-auth/startup-diagnostic"

const actualRuntime = await import("../../src/runtime")

const calls = {
  derived: new Array<unknown[]>(),
  histories: 0,
  historyScopes: new Array<unknown>(),
  processes: new Array<string>(),
  logs: 0,
  lists: new Array<unknown>(),
  productions: new Array<Request>(),
  sandboxes: new Array<unknown>(),
  starts: new Array<unknown[]>(),
}
type SandboxState = { status: string; lastChange?: number; exitCode?: number; metadata?: string }
type NativeProcess = { status: string; exitCode?: number; stdout: string; stderr: string }
const privateValue = "private-token-path-url-message-never-report"
let diagnosticFault: string | undefined
const sandbox = {
  canaryStateArgs: new Array<unknown[]>(),
  stopCalls: new Array<unknown>(),
  state: { status: "healthy", lastChange: 123, exitCode: 0, metadata: "secret" } as SandboxState,
  lastStop: { exitCode: 143, reason: "runtime_signal" },
  process: null as NativeProcess | null,
  async startupFailure() {
    return {
      bootCount: 1,
      diagnostic: { phase: "retire_root", code: "EXDEV", overlay: true, workspaceMount: false, exitCode: null },
    }
  },
  async canaryState(...args: unknown[]) {
    this.canaryStateArgs.push(args)
    await fault("state")
    return {
      bootCount: 2,
      lastStop: this.lastStop,
      state: {
        status: this.state.status,
        lastChange: this.state.lastChange,
        exitCode: this.state.exitCode,
      },
    }
  },
  async stop(signal: unknown) {
    this.stopCalls.push(signal)
  },
  async getState() {
    return this.state
  },
  async getProcess(id: string) {
    calls.processes.push(id)
    await fault("process")
    const process = this.process
    return (
      process && {
        ...process,
        command: privateValue,
        async getLogs() {
          calls.logs++
          await fault("logs")
          return { stdout: process.stdout, stderr: process.stderr }
        },
      }
    )
  },
  async containerFetch() {
    await fault("readiness")
    return Response.json({ private: privateValue }, { status: 503 })
  },
}
const bucket = {
  pages: new Array<{ objects: Array<{ key: string }>; truncated?: boolean; cursor?: string }>(),
  deletes: new Array<string[]>(),
  async list(options: { prefix: string; limit: number; cursor?: string }) {
    calls.lists.push(options)
    return this.pages.shift() ?? { objects: [], truncated: false }
  },
  async delete(names: string[]) {
    this.deletes.push(names)
  },
}

mock.module("cloudflare:workers", () => {
  class DurableObject<Env = unknown> {
    constructor(
      readonly ctx: DurableObjectState,
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

mock.module("@cloudflare/sandbox", () => {
  class Sandbox {
    envVars = {}
    defaultPort = 3000

    constructor(
      readonly ctx: DurableObjectState,
      readonly env: unknown,
    ) {}

    async onStart() {}
    async onStop() {}
    async stop() {}
    async getState() {
      return { status: "healthy" }
    }
    async containerFetch() {
      return new Response(null, { status: 204 })
    }
    startProcess() {
      return Promise.resolve({})
    }
    async getProcess() {
      return null
    }
    static get outboundHandlers() {
      return {}
    }
  }

  return {
    ContainerProxy: class ContainerProxy {},
    Sandbox,
    getSandbox(namespace: unknown, id: string, options: unknown) {
      calls.sandboxes.push({ namespace, id, options })
      return sandbox
    },
  }
})

mock.module("../../src/index", () => ({
  ContainerProxy: class ContainerProxy {},
  MongolGPTSandbox: class MongolGPTSandbox {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: unknown,
    ) {}

    async onStart() {}
    async onStop() {}
    async startProcess(...args: unknown[]) {
      calls.starts.push(args)
      return {}
    }
    async stop() {}
    async getState() {
      return { status: "healthy" }
    }
  },
  default: {
    fetch(request: Request) {
      calls.productions.push(request)
      return new Response("native", { status: 209 })
    },
  },
}))

mock.module("../../src/runtime", () => ({
  ...actualRuntime,
  RUNTIME_PROCESS_ID: "mongolgpt-server",
  deriveRuntimeIdentity(...args: unknown[]) {
    calls.derived.push(args)
    return { sandboxID: "workspace-canary-derived", password: "unused" }
  },
}))

mock.module("../../src/history", () => ({
  createHistoryStore(db: unknown) {
    calls.histories++
    return {
      db,
      async epoch(scope: unknown) {
        calls.historyScopes.push(scope)
        await fault("history")
        return scope && 5
      },
      async checkpoint(scope: unknown) {
        calls.historyScopes.push(scope)
        await fault("history")
        return { data: { id: "chk_canary" }, digest: "digest" }
      },
      async fileRevision(scope: unknown) {
        calls.historyScopes.push(scope)
        await fault("history")
        return { data: { id: "rev_canary", checkpointID: "chk_canary", sequence: 7 }, digest: "digest" }
      },
    }
  },
}))

mock.module("../../src/checkpoint-rpc", () => ({
  handleCheckpointOutbound: async () => new Response(null, { status: 209 }),
}))

const canary = await import("./cloudflare-canary")
type CanaryRequest = Parameters<typeof canary.default.fetch>[0]

describe("cloudflare canary worker", () => {
  beforeEach(() => {
    calls.derived.length = 0
    calls.histories = 0
    calls.historyScopes.length = 0
    calls.processes.length = 0
    calls.logs = 0
    diagnosticFault = undefined
    calls.lists.length = 0
    calls.productions.length = 0
    calls.sandboxes.length = 0
    calls.starts.length = 0
    sandbox.canaryStateArgs.length = 0
    sandbox.stopCalls.length = 0
    sandbox.state = { status: "healthy", lastChange: 123, exitCode: 0, metadata: "secret" }
    sandbox.lastStop = { exitCode: 143, reason: "runtime_signal" }
    sandbox.process = {
      status: "failed",
      exitCode: 1,
      stdout: privateValue,
      stderr: `TypeError: ${privateValue} ENOENT`,
    }
    bucket.pages.length = 0
    bucket.deletes.length = 0
  })

  test("exports the fixed canary scope", () => {
    expect(canary.canaryScope).toEqual({
      accountID: "account_cloudflare_canary",
      workspaceID: "wrk_cloudflare_canary",
    })
  })

  test("startup diagnostics opt in only the canary native supervisor", async () => {
    const ctx = { storage: {} } as ConstructorParameters<typeof canary.CanarySandbox>[0]
    const options = { processId: "mongolgpt-server", env: { EXISTING: "preserved" } }
    await new canary.CanarySandbox(ctx, env()).startProcess("native", options)
    expect(calls.starts[0]).toEqual([
      "native",
      { ...options, env: { EXISTING: "preserved", [startupDiagnosticEnv]: "true" } },
    ])
    expect(options.env).toEqual({ EXISTING: "preserved" })
    await new canary.CanarySandbox(ctx, env({ STAGE: "production" })).startProcess("native", options)
    await new canary.CanarySandbox(ctx, env()).startProcess("user", { processId: "user" })
    expect(calls.starts.slice(1)).toEqual([
      ["native", options],
      ["user", { processId: "user" }],
    ])
  })

  test("startup failure survives stop and DO reconstruction without retaining private fields", async () => {
    const values = new Map<string, unknown>()
    const ctx = {
      storage: {
        async get(key: string) {
          return values.get(key)
        },
        async put(key: string, value: unknown) {
          values.set(key, value)
        },
      },
    } as unknown as ConstructorParameters<typeof canary.CanarySandbox>[0]
    const first = new canary.CanarySandbox(ctx, env())
    const diagnostic = {
      phase: "retire_root",
      code: "EXDEV",
      overlay: true,
      workspaceMount: false,
      exitCode: null,
    } as const
    await first.onStart()
    await first.recordStartupFailure(diagnostic)
    await first.onStop({ exitCode: 1, reason: "exit" })
    const second = new canary.CanarySandbox(ctx, env())
    expect(await second.startupFailure()).toEqual({ bootCount: 1, diagnostic })
    await expect(second.recordStartupFailure({ ...diagnostic, message: privateValue })).rejects.toThrow()
    await expect(
      new canary.CanarySandbox(ctx, env({ STAGE: "production" })).recordStartupFailure(diagnostic),
    ).rejects.toThrow()
    expect(await second.startupFailure()).toEqual({ bootCount: 1, diagnostic })
    expect(JSON.stringify([...values.values()])).not.toContain(privateValue)
  })

  test("rejects invalid gate inputs before touching history, durable objects, or production fetch", async () => {
    const invalid = [
      env({ STAGE: "production" }),
      env({ CANARY_RUN_ID: "mgpt-canary-x-1" }),
      env({ CANARY_ADMIN_TOKEN: "A".repeat(64) }),
      env(),
    ]

    for (const item of invalid) {
      const response = await canary.default.fetch(request("/__canary/state"), item)
      expect(response.status).toBe(403)
    }

    expect(calls.derived).toEqual([])
    expect(calls.histories).toBe(0)
    expect(calls.productions).toEqual([])
    expect(calls.sandboxes).toEqual([])
    expect(calls.lists).toEqual([])
  })

  test("requires the canary token for native delegated requests without bypassing production auth", async () => {
    const forbidden = await canary.default.fetch(request("/api/processes"), env())
    expect(forbidden.status).toBe(403)
    expect(calls.productions).toEqual([])

    const delegated = await canary.default.fetch(request("/api/processes", { token: true }), env())
    expect(delegated.status).toBe(209)
    expect(await delegated.text()).toBe("native")
    expect(calls.productions.map((call) => new URL(call.url).pathname)).toEqual(["/api/processes"])
    expect(calls.productions[0]!.headers.get("x-mongolgpt-canary-token")).toBeNull()
    expect(calls.sandboxes).toEqual([])
  })

  test("native delegation strips canary token from clone while preserving the caller request", async () => {
    const original = request("/native", { method: "POST", body: "payload", token: true })

    await canary.default.fetch(original, env())

    expect(original.headers.get("x-mongolgpt-canary-token")).toBe(token)
    expect(calls.productions[0]!.headers.get("x-mongolgpt-canary-token")).toBeNull()
    expect(calls.productions[0]!.method).toBe("POST")
    expect(await calls.productions[0]!.text()).toBe("payload")
  })

  test("state route is GET only, rejects query/body, and returns bounded canary fields from fixed scope", async () => {
    expect((await canary.default.fetch(request("/__canary/state?x=1", { token: true }), env())).status).toBe(400)
    expect(
      (await canary.default.fetch(request("/__canary/state", { method: "POST", token: true }), env())).status,
    ).toBe(405)

    const response = await canary.default.fetch(request("/__canary/state", { token: true }), env())
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      bootCount: 2,
      lastStop: { exitCode: 143, reason: "runtime_signal" },
      state: { status: "healthy", lastChange: 123, exitCode: 0 },
      epoch: 5,
      checkpointID: "chk_canary",
      revisionID: "rev_canary",
      revisionSequence: 7,
    })
    expect(calls.derived.at(-1)).toEqual([
      "account_cloudflare_canary",
      "wrk_cloudflare_canary",
      "runtime-secret-at-least-thirty-two-chars",
    ])
    expect(calls.sandboxes.at(-1)).toEqual({
      namespace: "binding",
      id: "workspace-canary-derived",
      options: { normalizeId: true, transport: "rpc", sleepAfter: "10m" },
    })
    expect(sandbox.canaryStateArgs).toEqual([[]])
  })

  test("stop route accepts only exact empty POST body and never destroys the sandbox", async () => {
    expect((await canary.default.fetch(request("/__canary/stop", { token: true }), env())).status).toBe(405)
    expect(
      (await canary.default.fetch(request("/__canary/stop", { method: "POST", body: "x", token: true }), env())).status,
    ).toBe(400)
    expect(
      (await canary.default.fetch(request("/__canary/stop?x=1", { method: "POST", token: true }), env())).status,
    ).toBe(400)

    const response = await canary.default.fetch(request("/__canary/stop", { method: "POST", token: true }), env())
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ accepted: true })
    expect(sandbox.stopCalls).toEqual(["SIGTERM"])
    expect("destroy" in sandbox).toBe(false)
  })

  test("diagnostics requires the complete canary gate before any side effects", async () => {
    for (const invalid of [
      env({ STAGE: "production" }),
      env({ CANARY_RUN_ID: "other-run" }),
      env({ CANARY_ADMIN_TOKEN: "A".repeat(64) }),
    ]) {
      expect((await canary.default.fetch(request("/__canary/diagnostics", { token: true }), invalid)).status).toBe(403)
    }
    expect((await canary.default.fetch(request("/__canary/diagnostics"), env())).status).toBe(403)
    expectNoCanaryEffects()
  })

  test("diagnostics is GET only and rejects queries before any SDK or history calls", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const response = await canary.default.fetch(request("/__canary/diagnostics", { method, token: true }), env())
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET")
    }
    expect((await canary.default.fetch(request("/__canary/diagnostics?x=1", { token: true }), env())).status).toBe(400)
    expectNoCanaryEffects()
  })

  test("diagnostics returns only fixed safe fields for the scoped native process and history", async () => {
    const response = await canary.default.fetch(request("/__canary/diagnostics", { token: true }), env())
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const value = await response.json()
    expect(value).toEqual({
      bootCount: 2,
      startupFailure: await sandbox.startupFailure(),
      readiness: null,
      lastStop: { exitCode: 143, reason: "runtime_signal" },
      containerStatus: "healthy",
      epoch: 5,
      checkpointPresent: true,
      revisionPresent: true,
      sequence: 7,
      process: {
        present: true,
        status: "failed",
        exitCode: 1,
        stdoutBytes: privateValue.length,
        stderrBytes: `TypeError: ${privateValue} ENOENT`.length,
        signals: ["TypeError", "ENOENT"],
      },
      failure: null,
    })
    expect<unknown>(sanitizeCanaryDiagnostics(value)).toEqual(value)
    expect(JSON.stringify(value)).not.toContain(privateValue)
    expect(JSON.stringify(value)).not.toContain("chk_canary")
    expect(JSON.stringify(value)).not.toContain("rev_canary")
    expect(JSON.stringify(value).length).toBeLessThan(4096)
    expect(calls.processes).toEqual(["mongolgpt-server"])
    expect(calls.logs).toBe(1)
    expect(calls.historyScopes).toEqual(Array(3).fill(canary.canaryScope))
    expect(calls.derived[0]).toEqual([
      canary.canaryScope.accountID,
      canary.canaryScope.workspaceID,
      env().MONGOLGPT_RUNTIME_SECRET,
    ])
    expect(sandbox.canaryStateArgs).toEqual([[]])
    expect(calls.productions).toEqual([])
    expect(calls.lists).toEqual([])
    expect(bucket.deletes).toEqual([])
    expect(sandbox.stopCalls).toEqual([])
  })

  test("diagnostics never starts a cold container to inspect its native process", async () => {
    for (const status of ["stopped", "stopped_with_code", "stopping"]) {
      sandbox.state = { status }
      const response = await canary.default.fetch(request("/__canary/diagnostics", { token: true }), env())
      const value = (await response.json()) as { containerStatus: string; process: unknown; failure: unknown }
      expect(value.containerStatus).toBe(status)
      expect(value.process).toEqual(emptyCanaryDiagnostics().process)
      expect(value.failure).toBeNull()
      expect(value).toHaveProperty("startupFailure", await sandbox.startupFailure())
    }
    expect(calls.processes).toEqual([])
    expect(calls.logs).toBe(0)
    expect(calls.productions).toEqual([])
    expect(sandbox.stopCalls).toEqual([])
  })

  test("a running native process is checked with the actual bounded admission probe", async () => {
    sandbox.process = { status: "running", stdout: "", stderr: "" }
    for (const transportFails of [false, true]) {
      diagnosticFault = transportFails ? "readiness-error" : undefined
      const response = await canary.default.fetch(request("/__canary/diagnostics", { token: true }), env())
      const value = await response.json()
      expect(value).toHaveProperty(
        "readiness",
        transportFails ? { code: "transport", status: null } : { code: "http_status", status: 503 },
      )
      expect(value).toHaveProperty("failure", null)
      expect(value).toHaveProperty("epoch", 5)
      expect<unknown>(sanitizeCanaryDiagnostics(value)).toEqual(value)
      expect(JSON.stringify(value)).not.toContain(privateValue)
    }
    expect(calls.starts).toEqual([])
    expect(sandbox.stopCalls).toEqual([])
  })

  test("an unknown private stop reason does not suppress current healthy process diagnostics", async () => {
    sandbox.lastStop = { exitCode: 143, reason: privateValue }
    const response = await canary.default.fetch(request("/__canary/diagnostics", { token: true }), env())
    const value = (await response.json()) as {
      bootCount: number
      lastStop: unknown
      containerStatus: string
      process: { present: boolean; status: string }
      failure: unknown
    }
    expect(value.bootCount).toBe(2)
    expect(value.lastStop).toEqual({ exitCode: 143, reason: null })
    expect(value.containerStatus).toBe("healthy")
    expect(value.process.present).toBe(true)
    expect(value.process.status).toBe("failed")
    expect(value.failure).toBeNull()
    expect(calls.processes).toEqual(["mongolgpt-server"])
    expect(calls.logs).toBe(1)
    expect(JSON.stringify(value)).not.toContain(privateValue)
  })

  test("diagnostics reports a missing process without requesting logs", async () => {
    sandbox.state = { status: "running" }
    sandbox.process = null
    const response = await canary.default.fetch(request("/__canary/diagnostics", { token: true }), env())
    const value = (await response.json()) as { process: unknown }
    expect(value.process).toEqual({ ...emptyCanaryDiagnostics().process, present: false })
    expect(calls.processes).toEqual(["mongolgpt-server"])
    expect(calls.logs).toBe(0)
  })

  test("diagnostic failures expose only an enum and preserve successful independent receipts", async () => {
    for (const stage of ["state", "history", "process", "logs"]) {
      diagnosticFault = `${stage}-error`
      const response = await canary.default.fetch(request("/__canary/diagnostics", { token: true }), env())
      const value = (await response.json()) as { failure: unknown; epoch: unknown; containerStatus: unknown }
      expect(response.status).toBe(200)
      expect(value.failure).toBe("unavailable")
      expect<unknown>(sanitizeCanaryDiagnostics(value)).toEqual(value)
      expect(JSON.stringify(value)).not.toContain(privateValue)
      if (stage !== "history") expect(value.epoch).toBe(5)
      if (stage !== "state") expect(value.containerStatus).toBe("healthy")
    }
  })

  test("all diagnostic reads share one deadline and timed-out state never leads to process lookup", async () => {
    const nativeSetTimeout = globalThis.setTimeout
    let deadlines = 0
    const accelerated = new Proxy(nativeSetTimeout, {
      apply(target, thisArg, [handler, milliseconds, ...args]) {
        if (milliseconds === 8000) deadlines++
        return Reflect.apply(target, thisArg, [handler, milliseconds === 8000 ? 20 : milliseconds, ...args])
      },
    })
    const clock = spyOn(globalThis, "setTimeout").mockImplementation(accelerated)
    try {
      for (const stage of ["state", "history", "process", "logs"]) {
        calls.processes.length = 0
        diagnosticFault = `${stage}-timeout`
        const response = await canary.default.fetch(request("/__canary/diagnostics", { token: true }), env())
        const value = (await response.json()) as { failure: unknown }
        expect(value.failure).toBe("timeout")
        expect<unknown>(sanitizeCanaryDiagnostics(value)).toEqual(value)
        expect(JSON.stringify(value)).not.toContain(privateValue)
        if (stage === "state") expect(calls.processes).toEqual([])
      }
      expect(deadlines).toBe(4)
    } finally {
      clock.mockRestore()
    }
  })

  test("admin routes accept CL0 and incoming streams that reach EOF without bytes", async () => {
    sandbox.state = { status: "stopped" }
    for (const route of adminRoutes) {
      for (const length of [undefined, "0"]) {
        for (const emptyChunks of [undefined, 0, 3]) {
          let reads = 0
          const body =
            emptyChunks === undefined
              ? null
              : new ReadableStream<Uint8Array>(
                  {
                    pull(controller) {
                      if (reads++ < emptyChunks) controller.enqueue(new Uint8Array(0))
                      else controller.close()
                    },
                  },
                  { highWaterMark: 0 },
                )
          const incoming = nativeIncoming(route, body, length === undefined ? {} : { "content-length": length })
          const response = await canary.default.fetch(incoming, env())
          expect(response.status).toBe(route.status)
          expect(body?.locked ?? false).toBe(false)
        }
      }
    }
    expect(sandbox.stopCalls).toEqual(Array(6).fill("SIGTERM"))
    expect(calls.productions).toEqual([])
  })

  test("admin routes reject nonzero or malformed declared lengths without reading or awaiting cancellation", async () => {
    let reads = 0
    let cancellations = 0
    for (const route of adminRoutes) {
      for (const length of ["1", "1000000", "-1", "invalid"]) {
        const body = new ReadableStream<Uint8Array>(
          {
            pull() {
              reads++
            },
            cancel() {
              cancellations++
              return new Promise(() => {})
            },
          },
          { highWaterMark: 0 },
        )
        const response = await canary.default.fetch(nativeIncoming(route, body, { "content-length": length }), env())
        expect(response.status).toBe(400)
      }
    }
    expect(reads).toBe(0)
    expect(cancellations).toBe(adminRoutes.length * 4)
    expectNoCanaryEffects()
  })

  test("admin routes reject actual bytes in incoming GET, CL0, and chunked bodies", async () => {
    let cancellations = 0
    const headers: HeadersInit[] = [{}, { "content-length": "0" }, { "transfer-encoding": "chunked" }]
    for (const route of adminRoutes) {
      for (const header of headers) {
        let reads = 0
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.enqueue(reads++ === 0 ? new Uint8Array(0) : Uint8Array.of(120))
            },
            cancel() {
              cancellations++
            },
          },
          { highWaterMark: 0 },
        )
        const response = await canary.default.fetch(nativeIncoming(route, body, header), env())
        expect(response.status).toBe(400)
        expect(reads).toBe(2)
        expect(body.locked).toBe(false)
      }
    }
    expect(cancellations).toBe(adminRoutes.length * 3)
    expectNoCanaryEffects()
  })

  test("admin routes cap zero-length chunks instead of reading indefinitely", async () => {
    let cancellations = 0
    for (const route of adminRoutes) {
      let reads = 0
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads++
            controller.enqueue(new Uint8Array(0))
          },
          cancel() {
            cancellations++
          },
        },
        { highWaterMark: 0 },
      )
      expect((await canary.default.fetch(nativeIncoming(route, body), env())).status).toBe(400)
      expect(reads).toBeGreaterThan(0)
      expect(reads).toBeLessThanOrEqual(4)
      expect(body.locked).toBe(false)
    }
    expect(cancellations).toBe(adminRoutes.length)
    expectNoCanaryEffects()
  })

  test("admin routes time out stalled bodies even when cancellation never settles", async () => {
    let cancellations = 0
    const started = Date.now()
    await Promise.all(
      adminRoutes.map(async (route) => {
        const body = new ReadableStream<Uint8Array>(
          {
            pull() {
              return new Promise(() => {})
            },
            cancel() {
              cancellations++
              return new Promise(() => {})
            },
          },
          { highWaterMark: 0 },
        )
        const response = await canary.default.fetch(nativeIncoming(route, body, { "content-length": "0" }), env())
        expect(response.status).toBe(400)
        expect(body.locked).toBe(false)
      }),
    )
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(cancellations).toBe(adminRoutes.length)
    expectNoCanaryEffects()
  }, 4_000)

  test("admin routes fail closed when an incoming body read errors", async () => {
    for (const route of adminRoutes) {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.error(new Error("body read failed"))
          },
        },
        { highWaterMark: 0 },
      )
      expect((await canary.default.fetch(nativeIncoming(route, body), env())).status).toBe(400)
      expect(body.locked).toBe(false)
    }
    expectNoCanaryEffects()
  })

  test("the canary gate rejects incoming streams before any body reads or admin side effects", async () => {
    let reads = 0
    let cancellations = 0
    for (const route of adminRoutes) {
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            reads++
          },
          cancel() {
            cancellations++
          },
        },
        { highWaterMark: 0 },
      )
      const incoming = nativeIncoming(route, body, { "content-length": "0" })
      incoming.headers.delete("x-mongolgpt-canary-token")
      expect((await canary.default.fetch(incoming, env())).status).toBe(403)
    }
    expect(reads).toBe(0)
    expect(cancellations).toBe(0)
    expectNoCanaryEffects()
  })

  test("unknown canary admin paths are not command endpoints", async () => {
    const response = await canary.default.fetch(request("/__canary/exec", { method: "POST", token: true }), env())

    expect(response.status).toBe(404)
    expect(sandbox.stopCalls).toEqual([])
    expect((await canary.default.fetch(request("/__canary", { token: true }), env())).status).toBe(404)
  })

  test("purge rejects active sandbox state before listing or deleting backups", async () => {
    const response = await canary.default.fetch(request("/__canary/purge", { method: "POST", token: true }), env())

    expect(response.status).toBe(409)
    expect(calls.lists).toEqual([])
    expect(bucket.deletes).toEqual([])
  })

  test("purge rejects query and nonempty bodies before touching backups", async () => {
    expect(
      (await canary.default.fetch(request("/__canary/purge?x=1", { method: "POST", token: true }), env())).status,
    ).toBe(400)
    expect(
      (await canary.default.fetch(request("/__canary/purge", { method: "POST", body: "x", token: true }), env()))
        .status,
    ).toBe(400)
    expect(calls.lists).toEqual([])
    expect(bucket.deletes).toEqual([])
  })

  test("purge rejects unauthorized requests before durable object lookup or backup listing", async () => {
    const response = await canary.default.fetch(request("/__canary/purge", { method: "POST" }), env())

    expect(response.status).toBe(403)
    expect(calls.sandboxes).toEqual([])
    expect(calls.lists).toEqual([])
    expect(bucket.deletes).toEqual([])
  })

  test("purge deletes only listed synthetic backup objects after stopped state", async () => {
    sandbox.state = { status: "stopped" }
    bucket.pages.push({
      objects: [
        { key: "runtime-backups/v1/account_cloudflare_canary/wrk_cloudflare_canary/backup-a/manifest.json" },
        { key: "runtime-backups/v1/account_cloudflare_canary/wrk_cloudflare_canary/backup-a/000000.bin" },
      ],
      truncated: false,
    })

    const response = await canary.default.fetch(request("/__canary/purge", { method: "POST", token: true }), env())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ purged: 2 })
    expect(calls.lists).toEqual([
      {
        prefix: "runtime-backups/v1/account_cloudflare_canary/wrk_cloudflare_canary/",
        limit: 1000,
        cursor: undefined,
      },
    ])
    expect(bucket.deletes).toEqual([
      [
        "runtime-backups/v1/account_cloudflare_canary/wrk_cloudflare_canary/backup-a/manifest.json",
        "runtime-backups/v1/account_cloudflare_canary/wrk_cloudflare_canary/backup-a/000000.bin",
      ],
    ])
  })

  test("purge fails closed on nonmatching listed objects without deletion", async () => {
    sandbox.state = { status: "stopped_with_code" }
    bucket.pages.push({
      objects: [{ key: "runtime-backups/v1/other/wrk_cloudflare_canary/backup-a/manifest.json" }],
      truncated: false,
    })

    await expect(
      canary.default.fetch(request("/__canary/purge", { method: "POST", token: true }), env()),
    ).rejects.toThrow("escaped prefix")
    expect(bucket.deletes).toEqual([])
  })

  test("purge fails closed when the canary backup listing exceeds the bounded cap", async () => {
    sandbox.state = { status: "stopped" }
    for (let page = 0; page < 5; page++) {
      bucket.pages.push({
        objects: Array.from({ length: 1000 }, (_value, index) => ({
          key: `runtime-backups/v1/account_cloudflare_canary/wrk_cloudflare_canary/backup-${page}/${index}.bin`,
        })),
        truncated: true,
        cursor: `cursor-${page}`,
      })
    }

    await expect(
      canary.default.fetch(request("/__canary/purge", { method: "POST", token: true }), env()),
    ).rejects.toThrow("truncated beyond cap")
    expect(bucket.deletes).toEqual([])
  })

  test("purge fails closed on empty truncated pages and repeated cursors", async () => {
    sandbox.state = { status: "stopped", lastChange: 456, exitCode: 0, metadata: "secret" }
    bucket.pages.push({ objects: [], truncated: true, cursor: "cursor-1" })

    await expect(
      canary.default.fetch(request("/__canary/purge", { method: "POST", token: true }), env()),
    ).rejects.toThrow("truncated empty page")
    expect(bucket.deletes).toEqual([])

    bucket.pages.length = 0
    bucket.pages.push(
      {
        objects: [{ key: "runtime-backups/v1/account_cloudflare_canary/wrk_cloudflare_canary/backup-a/manifest.json" }],
        truncated: true,
        cursor: "same",
      },
      {
        objects: [{ key: "runtime-backups/v1/account_cloudflare_canary/wrk_cloudflare_canary/backup-b/manifest.json" }],
        truncated: true,
        cursor: "same",
      },
    )

    await expect(
      canary.default.fetch(request("/__canary/purge", { method: "POST", token: true }), env()),
    ).rejects.toThrow("invalid cursor")
    expect(bucket.deletes).toEqual([])
  })
})

const adminRoutes = [
  { path: "/__canary/state", method: "GET", status: 200 },
  { path: "/__canary/diagnostics", method: "GET", status: 200 },
  { path: "/__canary/stop", method: "POST", status: 202 },
  { path: "/__canary/purge", method: "POST", status: 200 },
]

function nativeIncoming(
  route: { path: string; method: string },
  body: ReadableStream<Uint8Array> | null,
  headers: HeadersInit = {},
) {
  const incoming = request(route.path, { method: route.method, token: true })
  new Headers(headers).forEach((value, key) => incoming.headers.set(key, value))
  // Workers incoming GETs may have a stream; Bun's Request constructor forbids a GET body.
  Object.defineProperty(incoming, "body", { value: body })
  return incoming
}

function expectNoCanaryEffects() {
  expect(calls.derived).toEqual([])
  expect(calls.histories).toBe(0)
  expect(calls.historyScopes).toEqual([])
  expect(calls.processes).toEqual([])
  expect(calls.logs).toBe(0)
  expect(calls.lists).toEqual([])
  expect(calls.productions).toEqual([])
  expect(calls.sandboxes).toEqual([])
  expect(sandbox.stopCalls).toEqual([])
  expect(bucket.deletes).toEqual([])
}

function request(path: string, options: { method?: string; body?: BodyInit; token?: boolean } = {}): CanaryRequest {
  const value = new Request(`https://runtime.example${path}`, {
    method: options.method,
    body: options.body,
    headers: options.token ? { "x-mongolgpt-canary-token": token } : undefined,
  })
  Object.defineProperty(value, "cf", {
    value: {
      colo: "DFW",
      edgeRequestKeepAliveStatus: 1,
      httpProtocol: "HTTP/2",
      requestPriority: "weight=16;exclusive=0;group=0;group-weight=0",
      tlsCipher: "AEAD-AES128-GCM-SHA256",
      tlsVersion: "TLSv1.3",
    },
  })
  return value as CanaryRequest
}

async function fault(stage: string) {
  if (diagnosticFault === `${stage}-error`) throw new Error(privateValue)
  if (diagnosticFault === `${stage}-timeout`) await new Promise<never>(() => {})
}

const token = "0".repeat(64)

function env(overrides: Partial<Parameters<typeof canary.default.fetch>[1]> = {}) {
  return {
    STAGE: "dev",
    CANARY_RUN_ID: "mgpt-canary-123456789012-123",
    CANARY_ADMIN_TOKEN: token,
    MONGOLGPT_RUNTIME_SECRET: "runtime-secret-at-least-thirty-two-chars",
    Sandbox: "binding",
    HISTORY: "history",
    RUNTIME_BACKUPS: bucket,
    ...overrides,
  } as Parameters<typeof canary.default.fetch>[1]
}
