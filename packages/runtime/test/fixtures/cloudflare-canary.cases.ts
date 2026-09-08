import { beforeEach, describe, expect, mock, test } from "bun:test"

const calls = {
  derived: new Array<unknown[]>(),
  histories: 0,
  lists: new Array<unknown>(),
  productions: new Array<Request>(),
  sandboxes: new Array<unknown>(),
}
type SandboxState = { status: string; lastChange?: number; exitCode?: number; metadata?: string }
const sandbox = {
  canaryStateArgs: new Array<unknown[]>(),
  stopCalls: new Array<unknown>(),
  state: { status: "healthy", lastChange: 123, exitCode: 0, metadata: "secret" } as SandboxState,
  async canaryState(...args: unknown[]) {
    this.canaryStateArgs.push(args)
    return {
      bootCount: 2,
      lastStop: { exitCode: 143, reason: "runtime_signal" },
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
        return scope && 5
      },
      async checkpoint() {
        return { data: { id: "chk_canary" }, digest: "digest" }
      },
      async fileRevision() {
        return { data: { id: "rev_canary", checkpointID: "chk_canary", sequence: 7 }, digest: "digest" }
      },
    }
  },
}))

const canary = await import("./cloudflare-canary")
type CanaryRequest = Parameters<typeof canary.default.fetch>[0]

describe("cloudflare canary worker", () => {
  beforeEach(() => {
    calls.derived.length = 0
    calls.histories = 0
    calls.lists.length = 0
    calls.productions.length = 0
    calls.sandboxes.length = 0
    sandbox.canaryStateArgs.length = 0
    sandbox.stopCalls.length = 0
    sandbox.state = { status: "healthy", lastChange: 123, exitCode: 0, metadata: "secret" }
    bucket.pages.length = 0
    bucket.deletes.length = 0
  })

  test("exports the fixed canary scope", () => {
    expect(canary.canaryScope).toEqual({
      accountID: "account_cloudflare_canary",
      workspaceID: "wrk_cloudflare_canary",
    })
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
