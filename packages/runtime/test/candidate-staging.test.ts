import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import candidate from "../wrangler.candidate.dev.json"
import {
  assertCandidateAbsent,
  candidateMetadata,
  candidateStagingCommand,
  candidateStagingContext,
  candidateStagingSecrets,
  runCandidateCommand,
  verifyCandidateDeployment,
  verifyCandidateRoutes,
} from "../script/stage-dev-runtime"

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "sergei10a-rgb/mongolgpt",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
  RUNNER_OS: "Linux",
  RUNNER_TEMP: resolve(tmpdir()),
  MONGOLGPT_CANDIDATE_CONFIRMATION: "STAGE DEV RUNTIME CANDIDATE",
  CLOUDFLARE_ACCOUNT_ID: candidate.account_id,
  CLOUDFLARE_API_TOKEN: "candidate-unit-test-token-not-real",
}
const secrets = {
  MONGOLGPT_RUNTIME_SECRET: "r".repeat(32),
  MONGOLGPT_RUNTIME_AUTH_SECRET: "a".repeat(32),
  MONGOLGPT_RUNTIME_BACKUP_KEYS: JSON.stringify({ dev_20260912_v1: Buffer.alloc(32, 1).toString("base64") }),
}

test("staging is restricted to explicit owner main Linux dev context", () => {
  expect(candidateStagingContext(env)).toEqual({
    worker: candidate.name,
    accountID: candidate.account_id,
    sourceCommit: env.GITHUB_SHA,
    output: join(env.RUNNER_TEMP, "runtime-candidate-receipt.json"),
  })
  for (const key of Object.keys(env)) expect(() => candidateStagingContext({ ...env, [key]: "" })).toThrow()
  for (const change of [
    { GITHUB_REPOSITORY: "anomalyco/opencode" },
    { GITHUB_REF: "refs/heads/production" },
    { RUNNER_OS: "Windows" },
    { CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) },
    { MONGOLGPT_CANDIDATE_CONFIRMATION: "DEPLOY DEV RUNTIME runtime.dev.mgpt.mn" },
    { RUNNER_TEMP: "relative" },
    { GITHUB_SHA: "not-a-commit" },
  ])
    expect(() => candidateStagingContext({ ...env, ...change })).toThrow()
})

test("staging uses the existing versioned dev master, never generates one", () => {
  expect(candidateStagingSecrets({ ...secrets, UNRELATED_SECRET: "do not pass through" })).toEqual(secrets)
  for (const key of Object.keys(secrets)) {
    for (const value of ["", "short", " " + "s".repeat(32), "s".repeat(8193), "s".repeat(32) + "\n"])
      expect(() => candidateStagingSecrets({ ...secrets, [key]: value })).toThrow()
  }
  expect(() =>
    candidateStagingSecrets({ ...secrets, MONGOLGPT_RUNTIME_AUTH_SECRET: secrets.MONGOLGPT_RUNTIME_SECRET }),
  ).toThrow()
  for (const keys of [
    null,
    [],
    {},
    { prod_20260912_v1: Buffer.alloc(32).toString("base64") },
    { dev_20260912_v1: Buffer.alloc(31).toString("base64") },
    { dev_20260912_v1: "not-base64" },
    { dev_20260912_v1: Buffer.alloc(32).toString("base64").replace(/=$/, "") },
    { dev_20260912_v1: Buffer.alloc(32).toString("base64"), extra: "bad" },
  ])
    expect(() => candidateStagingSecrets({ ...secrets, MONGOLGPT_RUNTIME_BACKUP_KEYS: JSON.stringify(keys) })).toThrow()
})

test("the staging command cannot select a primary config or add domain flags", () => {
  const node = resolve("node")
  const path = join(env.RUNNER_TEMP, "private folder", "secrets.json")
  const command = candidateStagingCommand(path, node)
  expect(command).toEqual([
    node,
    fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
    "deploy",
    `--config=${fileURLToPath(new URL("../wrangler.candidate.dev.json", import.meta.url))}`,
    `--secrets-file=${path}`,
  ])
  expect(command).not.toContain("--domain")
  expect(command).not.toContain("--route")
  expect(() => candidateStagingCommand("relative", node)).toThrow()
  expect(() => candidateStagingCommand(path, "node")).toThrow()
})

test("only a definite absence allows the initial deployment", () => {
  assertCandidateAbsent({ status: 404, value: { success: false, errors: [{ code: 10007 }] } })
  for (const status of [200, 401, 403, 409, 429, 500])
    expect(() => assertCandidateAbsent({ status, value: { success: false, errors: [{ code: 10007 }] } })).toThrow()
  for (const value of [
    null,
    {},
    { success: true, errors: [1] },
    { success: false, errors: [] },
    { success: false, errors: [{ code: 10000 }] },
    { success: false, errors: [{ code: 10007 }, { code: 10000 }] },
  ])
    expect(() => assertCandidateAbsent({ status: 404, value })).toThrow()
})

test("metadata is bounded and restricted to the exact candidate API", async () => {
  const paths = {
    settings: `workers/scripts/${candidate.name}/settings`,
    subdomain: `workers/scripts/${candidate.name}/subdomain`,
    routes: `workers/services/${candidate.name}/environments/production/routes?show_zonename=true`,
    domains: `workers/domains/records?page=0&per_page=5&service=${candidate.name}&environment=production`,
  }
  for (const endpoint of ["settings", "subdomain", "routes", "domains"] as const) {
    const result = await candidateMetadata(env.CLOUDFLARE_API_TOKEN, endpoint, async (url, init) => {
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${candidate.account_id}/${paths[endpoint]}`)
      expect(init.method).toBeUndefined()
      expect(init.redirect).toBe("error")
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${env.CLOUDFLARE_API_TOKEN}`)
      return Response.json({ success: true, result: {} })
    })
    expect(result.status).toBe(200)
  }
  for (const response of [
    new Response("<html>not metadata</html>", { headers: { "content-type": "text/html" } }),
    new Response("x".repeat(65_537), { headers: { "content-type": "application/json" } }),
    new Response("not json", { headers: { "content-type": "application/json" } }),
  ])
    await expect(candidateMetadata(env.CLOUDFLARE_API_TOKEN, "settings", async () => response)).rejects.toThrow()
})

test("private ingress requires verified empty routes and custom domains", () => {
  const empty = { status: 200, value: { success: true, result: [] } }
  verifyCandidateRoutes(empty, empty)
  verifyCandidateRoutes(empty, { ...empty, value: { ...empty.value, result_info: { total_count: 0 } } })
  for (const invalid of [
    { ...empty, status: 403 },
    { ...empty, status: 404 },
    { ...empty, status: 500 },
    { status: 200, value: null },
    { status: 200, value: { success: false, result: [] } },
    { status: 200, value: { success: true } },
    { status: 200, value: { success: true, result: [{ hostname: "runtime.dev.mgpt.mn" }] } },
    { ...empty, value: { ...empty.value, result_info: { total_count: 1 } } },
    { ...empty, value: { ...empty.value, result_info: "invalid" } },
  ]) {
    expect(() => verifyCandidateRoutes(invalid, empty)).toThrow()
    expect(() => verifyCandidateRoutes(empty, invalid)).toThrow()
  }
})

test("actual staging entrypoint rejects invalid context without exposing secrets", async () => {
  for (const change of [
    { MONGOLGPT_CANDIDATE_CONFIRMATION: "invalid" },
    { MONGOLGPT_RUNTIME_BACKUP_KEYS: "private-invalid-json-".repeat(4) },
  ]) {
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("../script/stage-dev-runtime.ts", import.meta.url))],
      {
        env: { ...env, ...secrets, ...change, SystemRoot: process.env.SystemRoot },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    try {
      const stdout = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited).toBe(1)
      expect(stdout).toBe("")
      expect(stderr.trim()).toBe(
        "Candidate байршуулалт батлагдсангүй. Давтан байршуулалтаас өмнө receipt-ийг шалгана уу. Нууц утга хэвлээгүй.",
      )
      for (const value of [...Object.values(secrets), env.CLOUDFLARE_API_TOKEN, "private-invalid-json-"])
        expect(stdout + stderr).not.toContain(value)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }
}, 15_000)

test.skipIf(process.platform !== "linux")(
  "actual command isolates secrets and bounds subprocess failures",
  async () => {
    const childEnv = {
      ...env,
      ...secrets,
      NODE_OPTIONS: "--require /must-not-inherit",
      UNRELATED_SECRET: "private-other",
    }
    for (const authenticated of [false, true]) {
      const value = JSON.parse(
        await runCandidateCommand(
          [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
          5_000,
          authenticated,
          childEnv,
        ),
      )
      expect(value.CLOUDFLARE_API_TOKEN).toBe(authenticated ? env.CLOUDFLARE_API_TOKEN : undefined)
      expect(value.CLOUDFLARE_ACCOUNT_ID).toBe(authenticated ? candidate.account_id : undefined)
      for (const name of [...Object.keys(secrets), "NODE_OPTIONS", "UNRELATED_SECRET"])
        expect(value[name]).toBeUndefined()
    }
    await expect(
      runCandidateCommand(
        [process.execPath, "-e", "console.error('private-child-output'); process.exit(7)"],
        5_000,
        false,
        childEnv,
      ),
    ).rejects.toThrow("Candidate command failed; private command output was not logged")
    await expect(
      runCandidateCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], 100, false, childEnv),
    ).rejects.toThrow("Candidate command failed; private command output was not logged")
    await expect(
      runCandidateCommand(
        [process.execPath, "-e", "process.stdout.write('x'.repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000)"],
        5_000,
        false,
        childEnv,
      ),
    ).rejects.toThrow("Candidate response exceeded its bound")
  },
  20_000,
)

test("deployment receipt requires exact isolated storage, controls and disabled ingress", () => {
  expect(verifyCandidateDeployment(settings(), ingress())).toEqual({ namespaceID: "a".repeat(32) })
  const original = settings().value.result.bindings
  for (let index = 0; index < original.length; index++) {
    const missing = settings()
    missing.value.result.bindings.splice(index, 1)
    expect(() => verifyCandidateDeployment(missing, ingress())).toThrow()
    const duplicate = settings()
    duplicate.value.result.bindings.push(duplicate.value.result.bindings[index])
    expect(() => verifyCandidateDeployment(duplicate, ingress())).toThrow()
  }
  for (const [name, changes] of [
    ["HISTORY", { id: "d8930539-cb16-4613-9acc-9313c8f15ff3" }],
    ["RUNTIME_BACKUPS", { bucket_name: "another-bucket" }],
    ["Sandbox", { namespace_id: "ceb126c25207461582b78289fb6bc9d3" }],
    ["Sandbox", { namespace_id: "invalid" }],
    ["Sandbox", { script_name: "mongolgpt-runtime-dev" }],
    ["Sandbox", { class_name: "OtherClass" }],
    ["MONGOLGPT_RUNTIME_SECRET", { type: "plain_text" }],
    ["STAGE", { text: "production" }],
    ["MONGOLGPT_RUNTIME_ACCOUNT_CLEANUP", { text: "true" }],
    ["MONGOLGPT_CLOUD_HISTORY", { text: "false" }],
    ["MONGOLGPT_RUNTIME_RATE_LIMITER", { simple: { limit: 10000, period: 60 } }],
    ["MONGOLGPT_RUNTIME_RATE_LIMITER", { namespace_id: "206071802" }],
  ] as Array<[string, Record<string, unknown>]>) {
    const wrong = settings()
    Object.assign(wrong.value.result.bindings.find((item) => item.name === name)!, changes)
    expect(() => verifyCandidateDeployment(wrong, ingress())).toThrow()
  }
  const linked = settings()
  linked.value.result.bindings.push({ name: "RuntimeAccountCleanup", type: "service" })
  expect(() => verifyCandidateDeployment(linked, ingress())).toThrow()
  for (const result of [
    { enabled: true, previews_enabled: false },
    { enabled: false, previews_enabled: true },
    { enabled: false },
    {},
  ])
    expect(() => verifyCandidateDeployment(settings(), { status: 200, value: { success: true, result } })).toThrow()
  for (const status of [401, 403, 404, 500]) {
    expect(() => verifyCandidateDeployment({ ...settings(), status }, ingress())).toThrow()
    expect(() => verifyCandidateDeployment(settings(), { ...ingress(), status })).toThrow()
  }
})

test("workflow exposes only a manual dev staging action and only uploads its receipt", async () => {
  const source = await Bun.file(new URL("../../../.github/workflows/stage-dev-runtime.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(source) as {
    on: Record<string, unknown>
    concurrency: { group: string; "cancel-in-progress": boolean }
    permissions: Record<string, string>
    jobs: {
      stage: {
        if: string
        environment: string
        "timeout-minutes": number
        steps: Array<{
          name: string
          run?: string
          uses?: string
          if?: string
          env?: Record<string, string>
          with?: Record<string, unknown>
        }>
      }
    }
  }
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  expect(workflow.concurrency).toEqual({ group: "cloudflare-deploy-dev", "cancel-in-progress": false })
  expect(workflow.permissions).toEqual({ contents: "read" })
  const job = workflow.jobs.stage
  expect(job.environment).toBe("dev")
  expect(job.if).toBe("github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'")
  expect(job["timeout-minutes"]).toBe(45)
  expect(job.steps.find((step) => step.name === "Setup Node")?.with?.["node-version"]).toBe("24")
  const deploy = job.steps.find((step) => step.name === "Stage only the private runtime candidate")!
  expect(deploy.run).toBe("bun packages/runtime/script/stage-dev-runtime.ts")
  expect(Object.keys(deploy.env!).sort()).toEqual(
    [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "MONGOLGPT_CANDIDATE_CONFIRMATION",
      ...candidate.secrets.required,
    ].sort(),
  )
  for (const step of job.steps.filter((step) => step !== deploy))
    expect(JSON.stringify(step.env ?? {})).not.toContain("secrets.")
  const upload = job.steps.find((step) => step.name === "Upload only the candidate receipt")!
  expect(upload.if).toBe("always()")
  expect(upload.with?.path).toBe("${{ runner.temp }}/runtime-candidate-receipt.json")
  expect(job.steps.filter((step) => step.with?.path)).toHaveLength(1)
  for (const text of ["--domain", "migrations apply", "deploy.ts dev", "delete", "cleanup-only"])
    expect(source).not.toContain(text)
})

function settings() {
  const bindings: Array<Record<string, unknown>> = [
    { name: "Sandbox", type: "durable_object_namespace", namespace_id: "a".repeat(32), class_name: "MongolGPTSandbox" },
    { name: "HISTORY", type: "d1", id: candidate.d1_databases[0].database_id },
    { name: "RUNTIME_BACKUPS", type: "r2_bucket", bucket_name: candidate.r2_buckets[0].bucket_name },
    ...candidate.secrets.required.map((name) => ({ name, type: "secret_text" })),
    ...Object.entries(candidate.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    ...candidate.ratelimits.map((item) => ({ ...item, type: "ratelimit" })),
  ]
  return { status: 200, value: { success: true, result: { bindings } } }
}

function ingress() {
  return { status: 200, value: { success: true, result: { enabled: false, previews_enabled: false } } }
}
