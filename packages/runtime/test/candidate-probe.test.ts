import { describe, expect, test } from "bun:test"
import { probeCandidateService, probeErrorCode } from "../script/candidate-service-probe"
import { candidateProbeConfig, candidateProbeContext } from "../script/probe-dev-runtime"
import candidate from "../wrangler.candidate.dev.json"
import { createRuntimeHandler } from "../src/runtime"

function handler() {
  const runtime = createRuntimeHandler({
    sandbox: () => {
      throw new Error("Probe must not start a container")
    },
  })
  const limiter = {
    limit: async () => {
      throw new Error("Probe must not consume quota")
    },
  }
  const env = {
    ...candidate.vars,
    MONGOLGPT_RUNTIME_SECRET: "r".repeat(32),
    MONGOLGPT_RUNTIME_AUTH_SECRET: "a".repeat(32),
    MONGOLGPT_RUNTIME_BURST_LIMITER: limiter,
    MONGOLGPT_RUNTIME_RATE_LIMITER: limiter,
  }
  return (request: Request) => runtime(request, env)
}

describe("private candidate probe", () => {
  test("diagnostics expose only bounded numeric API codes, never error text or credentials", () => {
    expect(probeErrorCode({ cause: { code: 10000, message: "private" } })).toBe(10000)
    expect(probeErrorCode({ code: "private-token", message: "private" })).toBeUndefined()
    expect(probeErrorCode({ code: Infinity })).toBeUndefined()
    const cycle: { cause?: unknown } = {}
    cycle.cause = cycle
    expect(probeErrorCode(cycle)).toBeUndefined()
  })
  test("checks actual runtime handler without authentication, storage, container or quota use", async () => {
    const runtime = handler()
    const requests: Request[] = []
    expect(
      await probeCandidateService((request) => {
        requests.push(request)
        return runtime(request)
      }),
    ).toEqual({ health: 200, wrongOrigin: 403, anonymous: 401, invalidToken: 401 })
    expect(requests).toHaveLength(4)
    expect(requests.every((request) => request.method === "GET" && request.redirect === "error")).toBe(true)
    expect(requests.every((request) => new URL(request.url).hostname === "candidate.invalid")).toBe(true)
  })

  test.each([
    [200, { healthy: true, service: "mongolgpt-runtime", stage: "production", version: "0.1.1" }],
    [503, { healthy: false }],
    [200, { healthy: true, service: "mongolgpt-runtime", stage: "dev", version: "stale" }],
  ])("rejects unhealthy or wrong-environment/version health", async (status, body) => {
    await expect(probeCandidateService(async () => Response.json(body, { status }))).rejects.toThrow()
  })

  test("rejects unexpected authorization success without following it", async () => {
    const runtime = handler()
    await expect(
      probeCandidateService((request) =>
        request.url.endsWith("/global/health") ? runtime(request) : Promise.resolve(Response.json({ ok: true })),
      ),
    ).rejects.toThrow("HTTP contract")
  })

  test("bounds health data and rejects redirect/HTML responses", async () => {
    for (const response of [
      Response.redirect("https://runtime.dev.mgpt.mn"),
      new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }),
      Response.json({ data: "x".repeat(4097) }),
    ])
      await expect(probeCandidateService(async () => response)).rejects.toThrow()
  })

  test("only binds the private candidate without storage or public routes", () => {
    expect(candidateProbeConfig()).toEqual({
      name: "mongolgpt-candidate-probe-dev",
      account_id: candidate.account_id,
      compatibility_date: candidate.compatibility_date,
      workers_dev: false,
      preview_urls: false,
      routes: [],
      services: [{ binding: "CANDIDATE", service: "mongolgpt-runtime-candidate-dev", remote: true }],
    })
  })

  test("requires owner main Linux CI, explicit confirmation and the right account", () => {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "sergei10a-rgb/mongolgpt",
      GITHUB_REF: "refs/heads/main",
      RUNNER_OS: "Linux",
      GITHUB_SHA: "a".repeat(40),
      MONGOLGPT_CANDIDATE_CONFIRMATION: "PROBE DEV RUNTIME CANDIDATE",
      CLOUDFLARE_ACCOUNT_ID: candidate.account_id,
      CLOUDFLARE_API_TOKEN: "test-only-token",
      RUNNER_TEMP: process.cwd(),
    }
    expect(candidateProbeContext(env).worker).toBe(candidate.name)
    for (const key of Object.keys(env)) expect(() => candidateProbeContext({ ...env, [key]: "" })).toThrow()
    expect(() => candidateProbeContext({ ...env, RUNNER_TEMP: "relative" })).toThrow()
  })

  test("workflow does not receive runtime secrets or run a deploy/build/migration", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(new URL("../../../.github/workflows/probe-dev-runtime.yml", import.meta.url)).text(),
    ) as {
      jobs: { probe: { environment: string; steps: { name: string; run?: string; env?: Record<string, string> }[] } }
    }
    expect(workflow.jobs.probe.environment).toBe("dev")
    const step = workflow.jobs.probe.steps.find((step) => step.name === "Probe only the existing private candidate")!
    expect(step.run).toBe("bun packages/runtime/script/probe-dev-runtime.ts")
    expect(Object.keys(step.env!).sort()).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "MONGOLGPT_CANDIDATE_CONFIRMATION",
    ])
    expect(workflow.jobs.probe.steps.map((step) => step.run ?? "").join("\n")).not.toMatch(
      /wrangler deploy|sst deploy|migrations apply|build-sandbox/,
    )
  })
})
