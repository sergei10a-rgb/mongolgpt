import { expect, test } from "bun:test"
import { verifyRuntimeCapability } from "@mongolgpt/runtime-auth"
import { readCanaryJson, runCanaryProbe } from "../script/canary-probe"

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
  fault?: "file" | "exit" | "epoch" | "post" | "html" | "oversized" | "startup" | "startup-auth",
  propagation: Array<Response | Error> = [],
) {
  let bootCount = 1
  let epoch = 2
  let sequence = 3
  let stopped = false
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
      if (stopped) {
        stopped = false
        bootCount++
        if (fault !== "epoch") epoch++
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
      sequence++
      return Response.json({ accepted: true })
    }
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
  const result = await runCanaryProbe({ origin, adminToken, authSecret, version, request: runtime.request })
  expect(result).toEqual({
    ok: true,
    version,
    boots: [1, 2],
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
