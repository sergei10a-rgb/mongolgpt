import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import candidate from "../wrangler.candidate.dev.json"
import bridge from "../script/candidate-native-bridge"
import { probeNativeSession } from "../script/candidate-native-service"
import { nativeProbeContext } from "../script/probe-native-candidate"

const sessionID = "ses_candidate_12345_1"
const vars = { PROBE_KEY: "synthetic-local-key", PROBE_TOKEN: "synthetic-token", PROBE_SESSION: sessionID }

test("requires owner Linux CI and distinct synthetic run scope", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "sergei10a-rgb/mongolgpt",
    GITHUB_REF: "refs/heads/main",
    RUNNER_OS: "Linux",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_TEMP: process.cwd(),
    CLOUDFLARE_ACCOUNT_ID: candidate.account_id,
    CLOUDFLARE_API_TOKEN: "synthetic-cloud-token",
    MONGOLGPT_RUNTIME_AUTH_SECRET: "test-only-secret-".repeat(3),
    MONGOLGPT_CANDIDATE_CONFIRMATION: "VERIFY DEV CANDIDATE SESSION",
  }
  expect(nativeProbeContext(env)).toMatchObject({
    accountID: "account_candidate_12345_1",
    workspaceID: "wrk_candidate_12345_1",
    sessionID,
  })
  for (const key of Object.keys(env)) expect(() => nativeProbeContext({ ...env, [key]: "" })).toThrow()
  expect(() => nativeProbeContext({ ...env, GITHUB_RUN_ID: "real-account" })).toThrow()
  expect(nativeProbeContext({ ...env, GITHUB_RUN_ATTEMPT: "2" }).workspaceID).not.toBe(
    nativeProbeContext(env).workspaceID,
  )
})

test("bridge rejects arbitrary paths, origins, methods and unscoped callers", async () => {
  let forwarded = 0
  const env = {
    ...vars,
    CANDIDATE: {
      fetch: async () => {
        forwarded++
        return Response.json({})
      },
    },
  }
  for (const request of [
    new Request("https://local.invalid/api/session"),
    new Request("https://local.invalid/api/session?account=real", { headers: { "x-probe-key": vars.PROBE_KEY } }),
    new Request("https://local.invalid/api/pty", { headers: { "x-probe-key": vars.PROBE_KEY } }),
    new Request("https://local.invalid/api/session", { method: "DELETE", headers: { "x-probe-key": vars.PROBE_KEY } }),
    new Request("https://local.invalid/api/session", {
      headers: { "x-probe-key": vars.PROBE_KEY, origin: "https://evil.invalid" },
    }),
  ])
    expect((await bridge.fetch(request, env)).status).toBeGreaterThanOrEqual(400)
  expect(forwarded).toBe(0)
})

test("probe refuses old scope data and never retries failed or ambiguous POST", async () => {
  for (const status of [500, 502, 503]) {
    const methods: string[] = []
    await expect(
      probeNativeSession({
        sessionID,
        request: async (method) => {
          methods.push(method)
          return method === "GET" ? Response.json({ data: [] }) : Response.json({}, { status })
        },
      }),
    ).rejects.toThrow()
    expect(methods).toEqual(["GET", "POST"])
  }
  let calls = 0
  await expect(
    probeNativeSession({
      sessionID,
      request: async () => {
        calls++
        return Response.json({ data: [{ id: "existing" }] })
      },
    }),
  ).rejects.toThrow("not empty")
  expect(calls).toBe(1)
})

test("probe rejects redirects, HTML, wrong IDs and oversized bodies", async () => {
  for (const response of [
    Response.redirect("https://must-not-follow.invalid"),
    new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }),
    Response.json({ data: "x".repeat(65537) }),
  ])
    await expect(probeNativeSession({ sessionID, request: async () => response })).rejects.toThrow()
  let calls = 0
  await expect(
    probeNativeSession({
      sessionID,
      request: async () => {
        calls++
        return Response.json(calls === 1 ? { data: [] } : { data: { id: "wrong" } })
      },
    }),
  ).rejects.toThrow("creation")
  expect(calls).toBe(2)
})

test("slow startup cannot issue a POST with insufficient capability lifetime", async () => {
  let clock = Date.now()
  const methods: string[] = []
  await expect(
    probeNativeSession({
      sessionID,
      expiresAt: clock + 100_000,
      now: () => clock,
      request: async (method) => {
        methods.push(method)
        clock += 70_000
        return Response.json({ data: [] })
      },
    }),
  ).rejects.toThrow("insufficient for creation")
  expect(methods).toEqual(["GET"])
})

test("current bridge runs in workerd and confines all native traffic to the synthetic session", async () => {
  const { Miniflare } = createRequire(import.meta.resolve("wrangler"))("miniflare") as {
    Miniflare: new (options: Record<string, unknown>) => {
      dispatchFetch(url: string, init?: RequestInit): Promise<Response>
      dispose(): Promise<void>
    }
  }
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../script/candidate-native-bridge.ts", import.meta.url))],
    target: "browser",
    format: "esm",
  })
  expect(build.success).toBe(true)
  const outbound: string[] = []
  const seen: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = []
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    compatibilityDate: candidate.compatibility_date,
    modules: true,
    script: await build.outputs[0].text(),
    bindings: vars,
    serviceBindings: {
      CANDIDATE: async (request: Request) => {
        const body = request.method === "POST" ? await request.json() : undefined
        seen.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body })
        return Response.json({
          data: request.method === "POST" ? { id: sessionID } : seen.length === 1 ? [] : [{ id: sessionID }],
        })
      },
    },
    outboundService: (request: Request) => {
      outbound.push(request.url)
      return new Response(null, { status: 599 })
    },
  })
  try {
    expect(
      await probeNativeSession({
        sessionID,
        request: (method, signal) =>
          mf.dispatchFetch("http://localhost/api/session", {
            method,
            signal,
            headers: {
              "x-probe-key": vars.PROBE_KEY,
              cookie: "private-cookie",
              authorization: "Bearer other",
              "x-org-id": "real",
            },
            body: method === "POST" ? '{"model":"paid","accountID":"real"}' : undefined,
            redirect: "manual",
          }),
      }),
    ).toEqual({ nativeRead: true, sessionCreated: true, sessionReadback: true, nativeSessionOnly: true })
    expect(seen).toHaveLength(3)
    for (const entry of seen) {
      expect(entry.url).toBe("https://candidate.invalid/api/session?location%5Bdirectory%5D=%2Fworkspace")
      expect(entry.headers).toEqual({
        ...(entry.method === "POST"
          ? {
              "content-length": String(
                Buffer.byteLength(JSON.stringify({ id: sessionID, location: { directory: "/workspace" } })),
              ),
            }
          : {}),
        authorization: "Bearer synthetic-token",
        "content-type": "application/json",
        host: "candidate.invalid",
        origin: candidate.vars.MONGOLGPT_APP_ORIGIN,
      })
    }
    expect(seen[1].body).toEqual({ id: sessionID, location: { directory: "/workspace" } })
    expect(outbound).toEqual([])
  } finally {
    await mf.dispose()
  }
}, 30_000)

test("workflow permits no deploy, migration, provider credentials, or production target", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/probe-native-candidate.yml", import.meta.url)).text(),
  ) as {
    jobs: { probe: { environment: string; steps: { run?: string; env?: Record<string, string> }[] } }
  }
  expect(workflow.jobs.probe.environment).toBe("dev")
  const step = workflow.jobs.probe.steps.find(
    (step) => step.run === "bun packages/runtime/script/probe-native-candidate.ts",
  )!
  expect(Object.keys(step.env!).sort()).toEqual([
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "MONGOLGPT_CANDIDATE_CONFIRMATION",
    "MONGOLGPT_RUNTIME_AUTH_SECRET",
  ])
  expect(workflow.jobs.probe.steps.map((step) => step.run ?? "").join("\n")).not.toMatch(
    /wrangler deploy|sst deploy|migrations apply|build-sandbox/,
  )
})
