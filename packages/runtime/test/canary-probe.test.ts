import { expect, test } from "bun:test"
import { verifyRuntimeCapability } from "@mongolgpt/runtime-auth"
import { readCanaryJson, runCanaryProbe, type CanaryProbePhase } from "../script/canary-probe"

const origin = "https://mgpt-canary-12345-1.test-account.workers.dev"
const adminToken = "a".repeat(64)
const authSecret = "synthetic-canary-runtime-secret-for-tests"
const version = "0.0.0-canary-test"

test("an expired whole-probe deadline prevents further requests", async () => {
  const runtime = fixture()
  await expect(
    runCanaryProbe({ origin, adminToken, authSecret, version, request: runtime.request, signal: AbortSignal.abort() }),
  ).rejects.toThrow()
  expect(runtime.calls).toHaveLength(0)
})

test("shared canary response reader rejects HTML, oversized and malformed JSON", async () => {
  expect(await readCanaryJson<{ purged: number }>(Response.json({ purged: 3 }))).toEqual({ purged: 3 })
  for (const response of [
    new Response("<html>"),
    Response.json({ value: "x".repeat(70_000) }),
    new Response("{", { headers: { "content-type": "application/json" } }),
  ]) {
    await expect(readCanaryJson(response)).rejects.toThrow()
  }
})

function fixture(
  fault?:
    | "file"
    | "exit"
    | "epoch"
    | "epoch-jump"
    | "shutdown-epoch"
    | "post"
    | "html"
    | "oversized"
    | "startup"
    | "startup-auth",
  propagation: Array<Response | Error> = [],
  warmStarts = false,
) {
  let bootCount = 1
  let epoch = 2
  let sequence = 3
  let stopped = false
  let erased = false
  const calls: { path: string; method: string; body: unknown; admin: boolean; authorized: boolean }[] = []
  const commands: string[] = []
  let startupAttempts = 0
  const request: NonNullable<Parameters<typeof runCanaryProbe>[0]["request"]> = async (url, init) => {
    const incoming = new Request(url, init)
    const path = new URL(incoming.url).pathname
    const body = incoming.body ? await incoming.json() : undefined
    calls.push({
      path,
      method: incoming.method,
      body,
      admin: incoming.headers.has("x-mongolgpt-canary-token"),
      authorized: incoming.headers.has("authorization"),
    })
    expect(incoming.redirect).toBe("error")
    if (!incoming.headers.get("x-mongolgpt-canary-token")) {
      const next = propagation.shift()
      if (next instanceof Error) throw next
      return next ?? Response.json({ error: "forbidden" }, { status: 403 })
    }
    expect(incoming.headers.get("x-mongolgpt-canary-token")).toBe(adminToken)
    if (!path.startsWith("/__canary/") && path !== "/global/health") {
      const bearer = incoming.headers.get("authorization")?.slice(7)
      if (!bearer) return Response.json({}, { status: 401 })
      const identity = await verifyRuntimeCapability({ token: bearer, audience: origin, secret: authSecret })
      expect(identity.sub).toBe("account_cloudflare_canary")
      expect(identity.workspaceID).toBe("wrk_cloudflare_canary")
      if (erased) return Response.json({ code: "runtime_unavailable" }, { status: 502 })
      if (warmStarts) bootCount++
      if (stopped) {
        stopped = false
        bootCount++
        if (fault !== "epoch") epoch += fault === "epoch-jump" ? 2 : 1
      }
    }
    if (path === "/global/health") {
      if (fault === "html")
        return new Response("<html>static shell</html>", { headers: { "content-type": "text/html" } })
      if (fault === "oversized") return Response.json({ content: "x".repeat(70_000) })
      return Response.json({ healthy: true, stage: "dev", version })
    }
    if (path === "/__canary/state")
      return Response.json({
        bootCount,
        epoch,
        checkpointID: "synthetic-baseline",
        revisionID: "synthetic-revision",
        revisionSequence: sequence,
        state: { status: stopped ? "stopped_with_code" : "healthy" },
        lastStop: stopped ? { exitCode: fault === "exit" ? 1 : 0, reason: "exit" } : null,
      })
    if (path === "/__canary/stop") {
      expect(incoming.method).toBe("POST")
      expect(body).toBeUndefined()
      stopped = true
      if (fault === "shutdown-epoch") epoch++
      sequence++
      return Response.json({ accepted: true })
    }
    if (path === "/__canary/account-cleanup") {
      expect(incoming.method).toBe("POST")
      expect(body).toBeUndefined()
      erased = true
      stopped = true
      return Response.json({
        accountID: "account_cloudflare_canary",
        requestID: "del_mgpt-canary-12345-1",
        complete: true,
      })
    }
    if (path === "/__canary/account-cleanup-state")
      return Response.json({
        retired: erased,
        complete: erased,
        historyRows: 0,
        backupContentObjects: 0,
        retainedFences: 0,
        stopped,
        bootCount,
      })
    if (path === "/api/session") {
      if (incoming.method === "POST") {
        if (fault === "post") return Response.json({ error: "unavailable" }, { status: 503 })
        return Response.json({ data: { id: "ses_cloudflare_canary_restore" } })
      }
      startupAttempts++
      if (fault === "startup" && startupAttempts < 3) return Response.json({ error: "provisioning" }, { status: 503 })
      if (fault === "startup-auth") return Response.json({ error: "unauthorized" }, { status: 401 })
      return Response.json({ data: [] })
    }
    if (path === "/api/session/ses_cloudflare_canary_restore")
      return Response.json({ data: { id: "ses_cloudflare_canary_restore" } })
    if (path === "/api/pty") {
      commands.push((body as { args: string[] }).args[1])
      return Response.json({ data: { id: "pty_test" } })
    }
    if (path === "/api/pty/pty_test") return Response.json({ data: { status: "exited", exitCode: 0 } })
    if (path === "/file/content")
      return Response.json({
        type: "text",
        content: fault === "file" && bootCount === 2 ? "lost" : "mongolgpt-cloudflare-native-restore",
      })
    throw new Error("Unexpected canary test request")
  }
  return { request, calls, commands }
}

test("canary exercises real runtime paths with capabilities and checks shutdown and replacement receipts", async () => {
  const runtime = fixture()
  const phases: CanaryProbePhase[] = []
  const result = await runCanaryProbe({
    origin,
    adminToken,
    authSecret,
    version,
    request: runtime.request,
    onPhase: (phase) => {
      phases.push(phase)
    },
  })
  expect(phases).toEqual([
    "authorization",
    "initial_startup",
    "session_create",
    "initial_pty",
    "initial_readback",
    "initial_shutdown",
    "replacement_readback",
    "replacement_pty",
    "replacement_receipts",
    "replacement_shutdown",
    "cleanup_startup",
    "account_cleanup",
    "retired_access",
    "erasure_receipts",
    "complete",
  ])
  expect(result).toEqual({
    ok: true,
    version,
    startCallbacks: [1, 2],
    epoch: 3,
    revisionSequence: 5,
    realPTY: true,
    privilegedEndpointsDenied: true,
    tiniEntrypoint: true,
    distinctVirtualMachineBoot: true,
    ephemeralDiskReplaced: true,
    sessionRestored: true,
    fileRestored: true,
    gracefulExit: true,
    runtimeAccountErased: true,
    retiredAccessDenied: true,
  })
  expect(runtime.commands).toHaveLength(2)
  expect(runtime.commands[0]).toContain('test "$(id -u)" = 10001')
  expect(runtime.commands[0]).toContain("MONGOLGPT_SDK_CONTROL_TOKEN")
  expect(runtime.commands[0]).toContain("CLOUDFLARE_API_TOKEN")
  expect(runtime.commands[0]).toContain("/proc/1/cmdline")
  expect(runtime.commands[1]).toContain("test ! -e /tmp/mgpt-canary-ephemeral")
  expect(runtime.commands[1]).toContain('"$(cat /proc/sys/kernel/random/boot_id)" !=')
  expect(runtime.calls.filter((call) => call.path === "/__canary/stop")).toHaveLength(2)
})

test("warm SDK start callbacks do not count as extra virtual machine boots", async () => {
  const runtime = fixture(undefined, [], true)
  const result = await runCanaryProbe({ origin, adminToken, authSecret, version, request: runtime.request })
  expect(result.ok).toBe(true)
  expect(result.startCallbacks[1] - result.startCallbacks[0]).toBeGreaterThan(1)
  expect(result.epoch).toBe(3)
  expect(runtime.commands[1]).toContain('"$(cat /proc/sys/kernel/random/boot_id)" !=')
  const staleEpoch = fixture("epoch", [], true)
  await expect(
    runCanaryProbe({ origin, adminToken, authSecret, version, request: staleEpoch.request }),
  ).rejects.toThrow("Replacement did not acquire the next writer epoch")
})

for (const [phase, field, value] of [
  ["account_cleanup", "accountID", "other"],
  ["account_cleanup", "requestID", "del_other"],
  ["account_cleanup", "complete", false],
  ["erasure_receipts", "retired", false],
  ["erasure_receipts", "complete", false],
  ["erasure_receipts", "stopped", false],
  ["erasure_receipts", "historyRows", 1],
  ["erasure_receipts", "backupContentObjects", 1],
  ["erasure_receipts", "retainedFences", -1],
  ["erasure_receipts", "bootCount", 999],
] as const) {
  test(`cleanup rejects ${phase} with invalid ${field}`, async () => {
    const runtime = fixture()
    let current: CanaryProbePhase | undefined
    const error = await runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      onPhase: (phase) => {
        current = phase
      },
      request: async (url, init) => {
        const response = await runtime.request(url, init)
        if (current !== phase) return response
        return Response.json({ ...((await response.json()) as Record<string, unknown>), [field]: value })
      },
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(current).toBe(phase)
    expect(runtime.calls.filter((call) => call.path === "/__canary/account-cleanup")).toHaveLength(1)
  })
}

test("retirement rejection must be the runtime result, not a generic denial or a lost response", async () => {
  for (const result of [
    { status: 200, code: "runtime_unavailable" },
    { status: 401, code: "unauthorized" },
    { status: 502, code: "runtime_process_lookup_failed" },
    { status: 502, code: null },
    "network",
  ] as const) {
    const runtime = fixture()
    let phase: CanaryProbePhase | undefined
    const error = await runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      onPhase: (value) => {
        phase = value
      },
      request: async (url, init) => {
        if (phase !== "retired_access") return runtime.request(url, init)
        if (result === "network") throw new Error(authSecret)
        return Response.json({ code: result.code, detail: adminToken }, { status: result.status })
      },
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(phase).toBe("retired_access")
    expect(String(error)).not.toContain(authSecret)
    expect(String(error)).not.toContain(adminToken)
    expect(runtime.calls.some((call) => call.path === "/__canary/account-cleanup-state")).toBe(false)
  }
})

test("uncertain cleanup is never automatically retried or reported complete", async () => {
  const runtime = fixture()
  let phase: CanaryProbePhase | undefined
  let cleanups = 0
  await expect(
    runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      onPhase: (value) => {
        phase = value
      },
      request: async (url, init) => {
        if (phase !== "account_cleanup") return runtime.request(url, init)
        cleanups++
        return Response.json({ error: authSecret }, { status: 503 })
      },
    }),
  ).rejects.toThrow("HTTP 503")
  expect(cleanups).toBe(1)
  expect(phase).toBe("account_cleanup")
  expect(runtime.calls.some((call) => call.path === "/__canary/account-cleanup-state")).toBe(false)
})

test.each(["initial_readback", "replacement_readback"] as const)(
  "retains the exact %s failure phase and safe readiness",
  async (failedPhase) => {
    const runtime = fixture()
    const phases: CanaryProbePhase[] = []
    const error = await runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      onPhase: (phase) => {
        phases.push(phase)
      },
      request: (url, init) => {
        if (phases.at(-1) === failedPhase && url.includes(`/api/session/ses_cloudflare_canary_restore`)) {
          return Promise.resolve(
            Response.json(
              {
                code: "runtime_unavailable",
                readiness: { code: "timeout", status: null },
                readinessBudgetMs: 1,
                message: adminToken,
                responseBody: authSecret,
              },
              { status: 502 },
            ),
          )
        }
        return runtime.request(url, init)
      },
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('"readiness":{"code":"timeout","status":null}')
    expect(String(error)).toContain('"readinessBudgetMs":1')
    expect(String(error)).not.toContain(adminToken)
    expect(String(error)).not.toContain(authSecret)
    expect(phases.at(-1)).toBe(failedPhase)
    expect(runtime.calls.filter((call) => call.path === "/__canary/stop")).toHaveLength(
      failedPhase === "initial_readback" ? 0 : 1,
    )
  },
)

test("canary suppresses malformed or private readiness metadata", async () => {
  for (const readiness of [
    { code: adminToken, status: 503 },
    { code: "timeout", status: null, message: authSecret },
    { code: "timeout", status: authSecret },
    { code: "ready", status: 503 },
  ]) {
    const runtime = fixture()
    let phase: CanaryProbePhase | undefined
    const error = await runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      onPhase: (value) => {
        phase = value
      },
      request: (url, init) =>
        phase === "session_create"
          ? Promise.resolve(Response.json({ code: "runtime_unavailable", readiness }, { status: 502 }))
          : runtime.request(url, init),
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain("readiness")
    expect(String(error)).not.toContain(adminToken)
    expect(String(error)).not.toContain(authSecret)
  }
})

test("canary suppresses invalid readiness budgets and budgets without valid readiness", async () => {
  for (const diagnostic of [
    ...[authSecret, 0, -1, 120_001, 1.5, null, { token: authSecret }].map((readinessBudgetMs) => ({
      readiness: { code: "timeout", status: null },
      readinessBudgetMs,
    })),
    { readiness: { code: authSecret, status: null }, readinessBudgetMs: 1 },
    { readinessBudgetMs: 1 },
  ]) {
    const runtime = fixture()
    let phase: CanaryProbePhase | undefined
    const error = await runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      onPhase: (value) => {
        phase = value
      },
      request: (url, init) =>
        phase === "session_create"
          ? Promise.resolve(Response.json({ code: "runtime_unavailable", ...diagnostic }, { status: 502 }))
          : runtime.request(url, init),
    }).catch((error: unknown) => error)
    expect(String(error)).toContain("runtime_unavailable")
    expect(String(error)).not.toContain("readinessBudgetMs")
    expect(String(error)).not.toContain(authSecret)
  }
})

test("initial read waits for provisioning but never retries a POST or authentication failure", async () => {
  const runtime = fixture("startup")
  const pauses: number[] = []
  const result = await runCanaryProbe({
    origin,
    adminToken,
    authSecret,
    version,
    request: runtime.request,
    pause: async (ms) => {
      pauses.push(ms)
    },
  })
  expect(result.ok).toBe(true)
  expect(pauses).toEqual([5000, 5000])
  expect(runtime.calls.filter((call) => call.path === "/api/session" && call.method === "POST")).toHaveLength(1)
  const denied = fixture("startup-auth")
  await expect(
    runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      request: denied.request,
      pause: async () => {
        throw new Error("must not retry authorization failure")
      },
    }),
  ).rejects.toThrow("HTTP 401")
  expect(denied.calls.filter((call) => call.method === "POST")).toHaveLength(0)
})

test("initial native read tolerates a transient 404 after the control gate succeeded", async () => {
  const runtime = fixture()
  const pauses: number[] = []
  let attempts = 0
  let phase: CanaryProbePhase | undefined
  const result = await runCanaryProbe({
    origin,
    adminToken,
    authSecret,
    version,
    onPhase: (value) => {
      phase = value
    },
    request: (url, init) => {
      if (
        phase === "initial_startup" &&
        new URL(url).pathname === "/api/session" &&
        init?.method === "GET" &&
        new Headers(init.headers).has("authorization")
      ) {
        if (++attempts === 1) return Promise.resolve(new Response("private edge response", { status: 404 }))
      }
      return runtime.request(url, init)
    },
    pause: async (ms) => {
      pauses.push(ms)
    },
  })
  expect(result.ok).toBe(true)
  expect(attempts).toBe(2)
  expect(pauses).toEqual([5000])
  expect(runtime.calls.filter((call) => call.method === "POST" && call.path === "/api/session")).toHaveLength(1)
})

test("a persistent initial native 404 exhausts the existing attempt bound without any POST", async () => {
  const runtime = fixture()
  let attempts = 0
  let pauses = 0
  const error = await runCanaryProbe({
    origin,
    adminToken,
    authSecret,
    version,
    request: (url, init) => {
      if (new URL(url).pathname === "/api/session" && new Headers(init?.headers).has("authorization")) {
        attempts++
        return Promise.resolve(new Response(authSecret, { status: 404 }))
      }
      return runtime.request(url, init)
    },
    pause: async () => {
      pauses++
    },
  }).catch((error: unknown) => error)
  expect(String(error)).toContain("attempt limit exceeded after 60 attempts")
  expect(String(error)).toContain("HTTP 404")
  expect(String(error)).not.toContain(authSecret)
  expect(attempts).toBe(60)
  expect(pauses).toBe(59)
  expect(runtime.calls.filter((call) => call.method === "POST")).toHaveLength(0)
})

test.each(["session_create", "initial_readback", "replacement_readback"] as const)(
  "a 404 in %s is never retried",
  async (failedPhase) => {
    const runtime = fixture()
    let phase: CanaryProbePhase | undefined
    let attempts = 0
    const error = await runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      onPhase: (value) => {
        phase = value
      },
      request: (url, init) => {
        if (phase === failedPhase) {
          attempts++
          return Promise.resolve(new Response(authSecret, { status: 404 }))
        }
        return runtime.request(url, init)
      },
      pause: async () => {
        throw new Error("must not retry")
      },
    }).catch((error: unknown) => error)
    expect(String(error)).toContain("HTTP 404")
    expect(String(error)).not.toContain(authSecret)
    expect(phase).toBe(failedPhase)
    expect(attempts).toBe(1)
  },
)

test("initial anonymous GET waits for propagation and requires the actual forbidden JSON receipt", async () => {
  const transient = [404, 502, 503, 504, 520, 522, 523, 524]
  const runtime = fixture(undefined, [
    ...transient.map((status) => new Response("private propagation body", { status })),
    new Error(`${adminToken} ${authSecret}`),
    Response.json({ error: "forbidden" }, { status: 403 }),
  ])
  const pauses: number[] = []
  const result = await runCanaryProbe({
    origin,
    adminToken,
    authSecret,
    version,
    request: runtime.request,
    pause: async (ms) => {
      pauses.push(ms)
    },
  })
  expect(result.ok).toBe(true)
  expect(pauses).toEqual(Array(transient.length + 1).fill(5000))
  const anonymous = runtime.calls.filter((call) => !call.admin)
  expect(anonymous).toHaveLength(transient.length + 2)
  expect(runtime.calls.slice(0, anonymous.length)).toEqual(anonymous)
  expect(
    anonymous.every(
      (call) => call.path === "/api/session" && call.method === "GET" && call.body === undefined && !call.authorized,
    ),
  ).toBe(true)
  expect(runtime.calls[anonymous.length]!.authorized).toBe(false)
  expect(runtime.calls.filter((call) => call.path === "/api/session" && call.method === "POST")).toHaveLength(1)
  expect(runtime.calls.filter((call) => call.path === "/__canary/stop")).toHaveLength(2)
})

test("initial anonymous success, redirects, and authentication failures are fatal with their actual status", async () => {
  for (const status of [200, 204, 301, 400, 401, 418]) {
    const runtime = fixture(undefined, [new Response(status === 204 ? null : adminToken, { status })])
    let pauses = 0
    await expect(
      runCanaryProbe({
        origin,
        adminToken,
        authSecret,
        version,
        request: runtime.request,
        pause: async () => {
          pauses++
        },
      }),
    ).rejects.toThrow(`unexpected HTTP ${status}`)
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]!.admin).toBe(false)
    expect(pauses).toBe(0)
  }
})

test("a wrong 403 body is fatal and never exposes private response contents", async () => {
  for (const response of [
    Response.json({}, { status: 403 }),
    Response.json({ error: authSecret }, { status: 403 }),
    Response.json(null, { status: 403 }),
    Response.json({ error: "forbidden", padding: "x".repeat(70_000) }, { status: 403 }),
    new Response(`{"error":"${adminToken}`, { status: 403, headers: { "content-type": "application/json" } }),
    new Response(`<html>${adminToken}</html>`, { status: 403, headers: { "content-type": "text/html" } }),
  ]) {
    const runtime = fixture(undefined, [response])
    let pauses = 0
    const error = await runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      request: runtime.request,
      pause: async () => {
        pauses++
      },
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Canary control gate returned invalid forbidden JSON (HTTP 403)")
    expect(String(error)).not.toContain(adminToken)
    expect(String(error)).not.toContain(authSecret)
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]!.admin).toBe(false)
    expect(pauses).toBe(0)
  }
})

test("propagation retries are capped and report the last HTTP status without response content", async () => {
  const runtime = fixture(
    undefined,
    Array.from({ length: 24 }, () => new Response(adminToken, { status: 503 })),
  )
  const pauses: number[] = []
  const error = await runCanaryProbe({
    origin,
    adminToken,
    authSecret,
    version,
    request: runtime.request,
    pause: async (ms) => {
      pauses.push(ms)
    },
  }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("propagation exhausted")
  expect((error as Error).message).toContain("HTTP 503")
  expect(String(error)).not.toContain(adminToken)
  expect(runtime.calls).toHaveLength(24)
  expect(pauses).toEqual(Array(23).fill(5000))
  expect(runtime.calls.every((call) => call.method === "GET" && !call.admin && !call.authorized)).toBe(true)
})

test("exhausted network retries suppress the original private error and its cause", async () => {
  const runtime = fixture(
    undefined,
    Array.from({ length: 24 }, () => new Error(`${adminToken} ${authSecret}`)),
  )
  const error = await runCanaryProbe({
    origin,
    adminToken,
    authSecret,
    version,
    request: runtime.request,
    pause: async () => {},
  }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("propagation exhausted")
  expect((error as Error).message).toContain("network failure")
  expect((error as Error).stack).not.toContain(adminToken)
  expect((error as Error).stack).not.toContain(authSecret)
  expect((error as Error).cause).toBeUndefined()
  expect(runtime.calls).toHaveLength(24)
  expect(runtime.calls.every((call) => call.method === "GET" && !call.admin && !call.authorized)).toBe(true)
})

test("propagation respects the whole-probe deadline between attempts without leaking its reason", async () => {
  const controller = new AbortController()
  const runtime = fixture(undefined, [new Response(null, { status: 404 })])
  const error = await runCanaryProbe({
    origin,
    adminToken,
    authSecret,
    version,
    request: runtime.request,
    signal: controller.signal,
    pause: async () => {
      controller.abort(new Error(adminToken))
    },
  }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("deadline")
  expect((error as Error).message).toContain("HTTP 404")
  expect(String(error)).not.toContain(adminToken)
  expect(runtime.calls).toHaveLength(1)
})

test("a stalled 403 response is cancelled at the deadline without retrying or waiting for cancellation", async () => {
  const controller = new AbortController()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        controller.abort(new Error(authSecret))
      },
      cancel() {
        cancelled = true
        return new Promise(() => {})
      },
    },
    { highWaterMark: 0 },
  )
  const runtime = fixture(undefined, [
    new Response(body, { status: 403, headers: { "content-type": "application/json" } }),
  ])
  let pauses = 0
  await expect(
    runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      request: runtime.request,
      signal: controller.signal,
      pause: async () => {
        pauses++
      },
    }),
  ).rejects.toThrow("invalid forbidden JSON (HTTP 403)")
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
  expect(runtime.calls).toHaveLength(1)
  expect(pauses).toBe(0)
})

test("native startup failures preserve only allowlisted diagnostic codes", async () => {
  for (const detail of [
    { code: "CONTAINER_UNAVAILABLE", reason: "no_container_instance_available" },
    { code: "PROCESS_EXITED_BEFORE_READY", exitCode: 1 },
    { code: "RPC_TRANSPORT_ERROR", kind: "upgrade_failed" },
    { code: adminToken, reason: authSecret },
  ]) {
    const runtime = fixture()
    const error = await runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      pause: async () => {},
      request: async (url, init) => {
        if (url.includes("/api/session?"))
          return Response.json(
            {
              code: "runtime_process_lookup_failed",
              diagnostic: { ...detail, message: adminToken },
              message: authSecret,
              stack: adminToken,
            },
            { status: 502 },
          )
        return runtime.request(url, init)
      },
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("HTTP 502")
    expect(String(error)).toContain("runtime_process_lookup_failed")
    expect(String(error)).not.toContain(adminToken)
    expect(String(error)).not.toContain(authSecret)
    if (detail.code !== adminToken) expect(String(error)).toContain(detail.code)
    if ("exitCode" in detail) expect(String(error)).toContain('"exitCode":1')
    if ("kind" in detail) expect(String(error)).toContain("upgrade_failed")
    expect(runtime.calls.filter((call) => call.method === "POST")).toEqual([])
  }
})

for (const phase of ["pause", "request"] as const) {
  test(`native startup deadline during ${phase} retains the last safe response`, async () => {
    const controller = new AbortController()
    const runtime = fixture()
    let attempts = 0
    const error = await runCanaryProbe({
      origin,
      adminToken,
      authSecret,
      version,
      signal: controller.signal,
      pause: async () => {
        if (phase === "pause") controller.abort(new Error(authSecret))
      },
      request: async (url, init) => {
        if (!url.includes("/api/session?")) return runtime.request(url, init)
        attempts++
        if (attempts === 2) {
          controller.abort(new Error(adminToken))
          throw new Error(authSecret)
        }
        return Response.json(
          {
            code: "runtime_process_port_timeout",
            diagnostic: { code: "PROCESS_EXITED_BEFORE_READY", exitCode: 7, message: adminToken },
            message: authSecret,
          },
          { status: 502 },
        )
      },
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("Native startup deadline exceeded")
    expect(String(error)).toContain("HTTP 502")
    expect(String(error)).toContain("runtime_process_port_timeout")
    expect(String(error)).toContain('"exitCode":7')
    expect(String(error)).not.toContain(adminToken)
    expect(String(error)).not.toContain(authSecret)
    expect(attempts).toBe(phase === "pause" ? 1 : 2)
    expect(runtime.calls.filter((call) => call.method === "POST")).toEqual([])
  })
}

test("probe cannot target existing dev, production, arbitrary URLs or malformed credentials", async () => {
  for (const target of [
    "https://runtime.dev.mgpt.mn",
    "https://mgpt.mn",
    "http://mgpt-canary-12345-1.test-account.workers.dev",
    `${origin}/`,
    `${origin}?secret=unexpected`,
    "https://mgpt-canary-12345-1.test-account.workers.dev.attacker.test",
  ]) {
    const runtime = fixture()
    await expect(
      runCanaryProbe({ origin: target, adminToken, authSecret, version, request: runtime.request }),
    ).rejects.toThrow("isolated workers.dev origin")
    expect(runtime.calls).toHaveLength(0)
  }
  const runtime = fixture()
  await expect(
    runCanaryProbe({ origin, adminToken: "short", authSecret, version, request: runtime.request }),
  ).rejects.toThrow("credentials")
  expect(runtime.calls).toHaveLength(0)
})

for (const [fault, message] of [
  ["file", "Native file did not survive"],
  ["exit", "shutdown did not exit successfully"],
  ["epoch", "next writer epoch"],
  ["epoch-jump", "next writer epoch"],
  ["shutdown-epoch", "Writer epoch changed during shutdown verification"],
  ["html", "endpoint failed"],
  ["oversized", "decoded safely"],
] as const) {
  test(`canary rejects ${fault} instead of reporting a passing hosted runtime`, async () => {
    const runtime = fixture(fault)
    await expect(runCanaryProbe({ origin, adminToken, authSecret, version, request: runtime.request })).rejects.toThrow(
      message,
    )
  })
}

test("uncertain POST is not automatically retried", async () => {
  const runtime = fixture("post")
  await expect(runCanaryProbe({ origin, adminToken, authSecret, version, request: runtime.request })).rejects.toThrow(
    "HTTP 503",
  )
  expect(runtime.calls.filter((call) => call.path === "/api/session" && call.method === "POST")).toHaveLength(1)
})
