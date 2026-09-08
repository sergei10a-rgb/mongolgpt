import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { canaryContext, cleanupCanaryRun } from "../script/test-cloudflare-canary"
import type { CanaryRequest } from "../script/canary-resources"

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "sergei10a-rgb/mongolgpt",
  GITHUB_REF: "refs/heads/main",
  GITHUB_RUN_ID: "12345",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: "a".repeat(40),
  MONGOLGPT_CANARY_CONFIRMATION: "RUN ISOLATED CLOUDFLARE CANARY",
  RUNNER_TEMP: resolve(tmpdir()),
  MONGOLGPT_CANARY_OUTPUT: join(resolve(tmpdir()), "mgpt-canary-12345-1"),
}

test("canary context permits only the explicit owner dev workflow and its private output directory", () => {
  expect(canaryContext(env, "linux")).toEqual({
    name: "mgpt-canary-12345-1",
    temp: env.RUNNER_TEMP,
    output: env.MONGOLGPT_CANARY_OUTPUT,
    version: "0.0.0-ci-canary-aaaaaaaaaaaa",
  })
  for (const changes of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REPOSITORY: "anomalyco/opencode" },
    { GITHUB_REF: "refs/heads/other" },
    { MONGOLGPT_CANARY_CONFIRMATION: "deploy production" },
    { GITHUB_RUN_ID: "../../production" },
    { GITHUB_RUN_ATTEMPT: "1000" },
    { GITHUB_SHA: "invalid" },
    { RUNNER_TEMP: "relative" },
    { MONGOLGPT_CANARY_OUTPUT: env.RUNNER_TEMP },
  ])
    expect(() => canaryContext({ ...env, ...changes }, "linux")).toThrow()
  expect(() => canaryContext(env, "win32")).toThrow()
})

test("canary workflow has no automatic deploy or production routes and cannot cancel another canary", async () => {
  const source = await Bun.file(
    new URL("../../../.github/workflows/verify-cloudflare-canary.yml", import.meta.url),
  ).text()
  const workflow = Bun.YAML.parse(source) as {
    on: Record<string, unknown>
    concurrency: { group: string; "cancel-in-progress": boolean }
    permissions: Record<string, string>
    jobs: {
      verify: {
        if: string
        environment: string
        "timeout-minutes": number
        steps: Array<{
          name: string
          run?: string
          if?: string
          "timeout-minutes"?: number
          with?: { path?: string }
          env?: Record<string, string>
        }>
      }
    }
  }
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  expect(workflow.concurrency).toEqual({ group: "cloudflare-isolated-canary", "cancel-in-progress": false })
  expect(workflow.permissions).toEqual({ contents: "read" })
  const job = workflow.jobs.verify
  expect(job.environment).toBe("dev")
  expect(job.if).toBe("github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'")
  expect(job["timeout-minutes"]).toBe(65)
  const build = job.steps.find((step) => step.name === "Build current authenticated container payload")!
  expect(build["timeout-minutes"]).toBe(10)
  const deploy = job.steps.find((step) => step.name === "Verify actual Cloudflare lifecycle in new isolated resources")!
  expect(deploy.run).toBe("bun packages/runtime/script/test-cloudflare-canary.ts")
  expect(deploy["timeout-minutes"]).toBe(30)
  expect(Object.keys(deploy.env!)).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"])
  const cleanup = job.steps.find((step) => step.name === "Independently clean up isolated canary resources")!
  expect(cleanup.if).toBe("always()")
  expect(cleanup["timeout-minutes"]).toBe(8)
  expect(cleanup.run).toBe("bun packages/runtime/script/test-cloudflare-canary.ts --cleanup-only")
  expect(cleanup.env).toEqual(deploy.env)
  expect(job.steps.indexOf(cleanup)).toBe(job.steps.indexOf(deploy) + 1)
  expect(job["timeout-minutes"] - build["timeout-minutes"]! - deploy["timeout-minutes"]!).toBeGreaterThan(8)
  expect(job.steps.find((step) => step.name === "Upload sanitized canary receipt")?.with?.path).toBe(
    "${{ env.MONGOLGPT_CANARY_OUTPUT }}/report.json",
  )
  expect(source).not.toContain("deploy-dev-runtime")
  expect(source).not.toContain("MONGOLGPT_ENABLE_REAL_PAYMENTS")
  expect(source).not.toContain("${{ runner.temp }}")
  expect(source).toContain(
    'echo "MONGOLGPT_CANARY_OUTPUT=$RUNNER_TEMP/mgpt-canary-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" >> "$GITHUB_ENV"',
  )
  expect(job.steps.filter((step) => step.with?.path).map((step) => step.with!.path)).toEqual([
    "${{ env.MONGOLGPT_CANARY_OUTPUT }}/report.json",
  ])
})

const temporaryDirectories: string[] = []
const databaseID = "11111111-2222-4333-8444-555555555555"
const adminToken = "d".repeat(64)
const apiToken = "test-canary-api-token"

afterEach(async () => {
  const prefix = join(await realpath(tmpdir()), "mgpt-canary-workflow-")
  for (const directory of temporaryDirectories.splice(0)) {
    if ((await realpath(directory)) !== directory || !directory.startsWith(prefix))
      throw new Error("Invalid temporary canary test directory")
    await rm(directory, { recursive: true, force: true })
  }
})

async function recoveryFiles(changes: Record<string, unknown> = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "mgpt-canary-workflow-")))
  temporaryDirectories.push(temp)
  const output = join(temp, "mgpt-canary-12345-1")
  await mkdir(output, { mode: 0o700 })
  const context = canaryContext({ ...env, RUNNER_TEMP: temp, MONGOLGPT_CANARY_OUTPUT: output }, "linux")
  const report = {
    name: context.name,
    version: context.version,
    ok: false,
    cleanupComplete: false,
    provisioningComplete: true,
    databaseID,
    r2BucketCreated: true,
    workerDeployed: false,
    ...changes,
  }
  await writeFile(join(output, "report.json"), JSON.stringify(report), { mode: 0o600 })
  await writeFile(join(output, "secrets.json"), JSON.stringify({ CANARY_ADMIN_TOKEN: adminToken }), { mode: 0o600 })
  return {
    context,
    env: {
      ...env,
      RUNNER_TEMP: temp,
      MONGOLGPT_CANARY_OUTPUT: output,
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: apiToken,
    },
    reportPath: join(output, "report.json"),
    secretsPath: join(output, "secrets.json"),
  }
}

test("independent cleanup recovers known resources without a build, then becomes an offline no-op", async () => {
  const files = await recoveryFiles()
  const requests: string[] = []
  const request: CanaryRequest = async (input, init) => {
    const url = new URL(input)
    expect(url.origin).toBe("https://api.cloudflare.com")
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiToken}`)
    expect(new Headers(init?.headers).has("x-mongolgpt-canary-token")).toBe(false)
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`)
    expect(
      url.pathname === `/client/v4/accounts/${files.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseID}` ||
        url.pathname === `/client/v4/accounts/${files.env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${files.context.name}`,
    ).toBe(true)
    return Response.json({ success: true, result: { name: files.context.name, uuid: databaseID } })
  }
  expect(await cleanupCanaryRun(files.env, "linux", request)).toBe(0)
  expect(requests.map((value) => value.split(" ")[0])).toEqual(["GET", "DELETE", "GET", "DELETE"])
  const report = JSON.parse(await readFile(files.reportPath, "utf8"))
  expect(report.cleanupComplete).toBe(true)
  expect(report.ok).toBe(false)
  expect(report.cleanup.deleted).toEqual([`r2:${files.context.name}`, `d1:${databaseID}`])
  expect(await Bun.file(files.secretsPath).exists()).toBe(false)
  expect(await Bun.file(join(files.context.output, "report.pending.json")).exists()).toBe(false)
  expect(await cleanupCanaryRun(files.env, "linux", request)).toBe(0)
  expect(requests).toHaveLength(4)
})

test("completed primary cleanup removes retained credentials without touching the network", async () => {
  const files = await recoveryFiles({
    cleanupComplete: true,
    cleanup: { name: "mgpt-canary-12345-1", deleted: [], skipped: [], failures: [], manualCleanup: [] },
  })
  let calls = 0
  expect(
    await cleanupCanaryRun(files.env, "linux", async () => {
      calls++
      throw new Error("Unexpected network")
    }),
  ).toBe(0)
  expect(calls).toBe(0)
  expect(await Bun.file(files.secretsPath).exists()).toBe(false)
})

test("cleanup rejects invalid current-run identities and origins before forwarding credentials", async () => {
  for (const changes of [
    { name: "mgpt-canary-999-1" },
    { databaseID: "../other-database" },
    { containerApplicationID: "https://other.invalid" },
    { cleanup: { name: "mgpt-canary-999-1" } },
    { cleanupComplete: true },
    {
      cleanupComplete: true,
      cleanup: { name: "mgpt-canary-12345-1", failures: [], manualCleanup: [] },
      manualCleanup: ["r2:mgpt-canary-12345-1:creation-status-uncertain"],
    },
    { workerDeployed: true, origin: "https://mgpt-canary-999-1.owner.workers.dev" },
    { workerDeployed: true, origin: "https://mgpt-canary-12345-1.owner.workers.dev@other.invalid" },
    { workerDeployed: true, origin: "https://mgpt-canary-12345-1.owner.workers.dev/redirect" },
  ]) {
    const files = await recoveryFiles(changes)
    let calls = 0
    await expect(
      cleanupCanaryRun(files.env, "linux", async () => {
        calls++
        throw new Error("Unexpected network")
      }),
    ).rejects.toThrow()
    expect(calls).toBe(0)
    expect(await Bun.file(files.secretsPath).exists()).toBe(false)
  }
  const files = await recoveryFiles()
  await expect(cleanupCanaryRun({ ...files.env, GITHUB_REF: "refs/heads/other" }, "linux")).rejects.toThrow()
  expect(await Bun.file(files.secretsPath).exists()).toBe(true)
})

test("cleanup bounds private JSON and suppresses malformed secret content", async () => {
  for (const body of ["x".repeat(65_537), `{"secret":"${adminToken}`]) {
    const files = await recoveryFiles()
    await writeFile(files.reportPath, body)
    let calls = 0
    await expect(
      cleanupCanaryRun(files.env, "linux", async () => {
        calls++
        throw new Error("Unexpected network")
      }),
    ).rejects.toThrow("Canary private JSON file is missing or invalid")
    expect(calls).toBe(0)
    expect(await Bun.file(files.secretsPath).exists()).toBe(false)
  }
})

test("deployed recovery uses scoped stop/purge and retains resources on purge failure without leaking secrets", async () => {
  const origin = "https://mgpt-canary-12345-1.owner.workers.dev"
  const files = await recoveryFiles({ workerDeployed: true, origin })
  const requests: Array<{ origin: string; path: string; method: string }> = []
  let stopping = false
  const request: CanaryRequest = async (input, init) => {
    const url = new URL(input)
    const method = init?.method ?? "GET"
    requests.push({ origin: url.origin, path: url.pathname, method })
    if (url.origin !== origin) return Response.json({ success: false }, { status: 404 })
    expect(new Headers(init?.headers).get("x-mongolgpt-canary-token")).toBe(adminToken)
    expect(init?.body).toBeUndefined()
    expect(init?.redirect).toBe("error")
    if (url.pathname === "/__canary/state")
      return Response.json({ state: { status: stopping ? "stopped" : "healthy" } })
    if (url.pathname === "/__canary/stop") {
      stopping = true
      return Response.json({ accepted: true })
    }
    if (url.pathname === "/__canary/purge") throw new Error(`${adminToken} ${apiToken}`)
    throw new Error("Unexpected canary request")
  }
  expect(await cleanupCanaryRun(files.env, "linux", request)).toBe(1)
  expect(requests.filter((value) => value.origin === origin).map((value) => `${value.method} ${value.path}`)).toEqual([
    "GET /__canary/state",
    "POST /__canary/stop",
    "GET /__canary/state",
    "POST /__canary/purge",
  ])
  expect(requests.some((value) => value.method === "DELETE")).toBe(false)
  const report = await readFile(files.reportPath, "utf8")
  expect(report).not.toContain(adminToken)
  expect(report).not.toContain(apiToken)
  expect(JSON.parse(report).cleanupComplete).toBe(false)
  expect(await Bun.file(files.secretsPath).exists()).toBe(false)
})

test("an interrupted partial creation cleans only recorded ownership and remains visibly incomplete", async () => {
  const files = await recoveryFiles({ provisioningComplete: false, r2BucketCreated: false })
  const paths: string[] = []
  expect(
    await cleanupCanaryRun(files.env, "linux", async (input) => {
      paths.push(new URL(input).pathname)
      return Response.json({ success: true, result: { name: files.context.name, uuid: databaseID } })
    }),
  ).toBe(1)
  expect(paths).toHaveLength(2)
  expect(paths.every((path) => path.endsWith(`/d1/database/${databaseID}`))).toBe(true)
  expect(JSON.parse(await readFile(files.reportPath, "utf8")).cleanupComplete).toBe(false)
  expect(await Bun.file(files.secretsPath).exists()).toBe(false)
})
