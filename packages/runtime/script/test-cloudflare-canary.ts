import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { validControlToken } from "@mongolgpt/runtime-auth/control"
import { verifySandboxBuild } from "./build-sandbox"
import { readCanaryJson, runCanaryProbe } from "./canary-probe"
import {
  CanaryResourceError,
  cleanupCanaryResourceReceipt,
  createCanaryConfig,
  createCanaryName,
  createCanaryResources,
  type CanaryResources,
  type CanaryCleanupResult,
  type CanaryRequest,
} from "./canary-resources"

const root = fileURLToPath(new URL("..", import.meta.url))
type CanaryReceipt = Parameters<typeof cleanupCanaryResourceReceipt>[0]["receipt"]

export function canaryContext(env: NodeJS.ProcessEnv, platform = process.platform) {
  if (
    platform !== "linux" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== "sergei10a-rgb/mongolgpt" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.MONGOLGPT_CANARY_CONFIRMATION !== "RUN ISOLATED CLOUDFLARE CANARY"
  )
    throw new Error("Canary provisioning is restricted to the confirmed owner dev workflow")
  const name = createCanaryName(env.GITHUB_RUN_ID ?? "", env.GITHUB_RUN_ATTEMPT ?? "")
  const temp = env.RUNNER_TEMP ?? ""
  if (!isAbsolute(temp) || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? ""))
    throw new Error("Canary runner identity is invalid")
  const output = resolve(temp, name)
  if (resolve(env.MONGOLGPT_CANARY_OUTPUT ?? "") !== output)
    throw new Error("Canary evidence path is outside its private run directory")
  return { name, temp: resolve(temp), output, version: `0.0.0-ci-canary-${env.GITHUB_SHA!.slice(0, 12)}` }
}

async function run() {
  const context = canaryContext(process.env)
  if ((await realpath(context.temp)) !== context.temp) throw new Error("Canary runner directory must be canonical")
  await verifySandboxBuild()
  const binary = join(root, "container/mongolgpt")
  const version = Bun.spawn([binary, "--version"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
    env: { PATH: process.env.PATH },
  })
  const versionDeadline = setTimeout(() => version.kill("SIGKILL"), 10_000)
  try {
    const reportedVersion = await new Response(version.stdout).text()
    if ((await version.exited) !== 0 || reportedVersion.trim() !== context.version)
      throw new Error("Canary executable is not the current build")
  } finally {
    clearTimeout(versionDeadline)
    if (version.exitCode === null) version.kill("SIGKILL")
    await version.exited
  }
  await mkdir(context.output, { mode: 0o700 })
  await chmod(context.output, 0o700)
  const backupKey = randomBytes(32).toString("base64")
  const secrets = {
    CANARY_ADMIN_TOKEN: randomBytes(32).toString("hex"),
    MONGOLGPT_RUNTIME_SECRET: randomBytes(32).toString("hex"),
    MONGOLGPT_RUNTIME_AUTH_SECRET: randomBytes(32).toString("hex"),
    MONGOLGPT_RUNTIME_BACKUP_KEYS: JSON.stringify({ key_canary: backupKey }),
  }
  const privateValues = [process.env.CLOUDFLARE_API_TOKEN ?? "", backupKey, ...Object.values(secrets)]
  const secretsPath = join(context.output, "secrets.json")
  const configPath = join(context.output, "wrangler.json")
  await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600, flag: "wx" })
  let resources: CanaryResources | undefined
  let deploymentAttempted = false
  let origin: string | undefined
  const report: Record<string, unknown> = { name: context.name, version: context.version, ok: false }
  report.r2BucketCreated = false
  report.workerDeployed = false
  report.cleanupComplete = false
  report.provisioningComplete = false
  await saveReport()
  try {
    resources = await createCanaryResources({
      accountID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      token: process.env.CLOUDFLARE_API_TOKEN ?? "",
      runID: process.env.GITHUB_RUN_ID!,
      attempt: process.env.GITHUB_RUN_ATTEMPT!,
      onReceipt: async (receipt: CanaryReceipt) => {
        if (receipt.name !== context.name) throw new Error("Canary resource receipt belongs to another run")
        Object.assign(report, receipt)
        await saveReport()
      },
    })
    origin = `https://${resources.name}.${resources.subdomain}.workers.dev`
    report.databaseID = resources.databaseID
    report.r2BucketCreated = true
    report.provisioningComplete = true
    report.origin = origin
    await saveReport()
    await writeFile(
      configPath,
      JSON.stringify(
        createCanaryConfig({
          resources,
          accountID: process.env.CLOUDFLARE_ACCOUNT_ID!,
          root,
          version: context.version,
        }),
      ),
      { mode: 0o600, flag: "wx" },
    )
    // Record only resource identity before the first possible remote deployment.
    await saveReport()
    await wrangler(
      ["d1", "migrations", "apply", "HISTORY", "--remote", `--config=${configPath}`],
      "migrations",
      120_000,
    )
    deploymentAttempted = true
    report.workerDeployed = true
    await saveReport()
    await wrangler(["deploy", `--config=${configPath}`, `--secrets-file=${secretsPath}`], "deploy", 600_000)
    report.probe = await runCanaryProbe({
      origin,
      adminToken: secrets.CANARY_ADMIN_TOKEN,
      authSecret: secrets.MONGOLGPT_RUNTIME_AUTH_SECRET,
      version: context.version,
    })
  } catch (error) {
    report.error = safeError(error)
    if (error instanceof CanaryResourceError) {
      report.cleanup = error.cleanup
      report.manualCleanup = error.manualCleanup
      report.cleanupComplete = cleanupComplete(error.cleanup) && error.manualCleanup.length === 0
    }
  } finally {
    if (resources) {
      const cleanup = await resources
        .cleanup({
          workerDeployed: deploymentAttempted,
          ...(deploymentAttempted ? { purge: () => stopAndPurge(origin!, secrets.CANARY_ADMIN_TOKEN) } : {}),
        })
        .catch(() => undefined)
      report.cleanup = cleanup ?? {
        name: context.name,
        deleted: [],
        skipped: [],
        manualCleanup: [],
        failures: [{ resource: context.name, message: "Cleanup did not return a receipt" }],
      }
      report.cleanupComplete = cleanupComplete(cleanup)
      report.ok = !!report.probe && report.cleanupComplete
    }
    await saveReport()
  }
  console.log(JSON.stringify(report))
  return report.ok === true ? 0 : 1

  async function saveReport() {
    await saveCanaryReport(context.output, report)
  }

  function safeError(error: unknown) {
    const text = error instanceof Error ? error.message : "Canary operation failed"
    return privateValues
      .filter(Boolean)
      .reduce((result, value) => result.split(value).join("[REDACTED]"), text)
      .slice(0, 1500)
  }

  async function wrangler(args: string[], label: string, timeout: number) {
    const node = Bun.which("node")
    if (!node) throw new Error("Canary requires the workflow's pinned Node runtime")
    const child = Bun.spawn([node, join(root, "node_modules/wrangler/bin/wrangler.js"), ...args], {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {}
    }
    const timer = setTimeout(stop, timeout)
    const capture = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > 16 * 1024 * 1024) {
          stop()
          throw new Error("Canary deploy log exceeded its limit")
        }
        chunks.push(next.value)
      }
      return Buffer.concat(chunks).toString("utf8")
    }
    try {
      const [stdout, stderr, code] = await Promise.all([capture(child.stdout), capture(child.stderr), child.exited])
      const log = privateValues
        .filter(Boolean)
        .reduce((result, value) => result.split(value).join("[REDACTED]"), `${stdout}\n${stderr}`)
      await writeFile(join(context.output, `${label}.log`), log, { mode: 0o600 })
      if (code !== 0) {
        console.error(`Canary ${label} failed (exit ${code}):\n${log.slice(-4000)}`)
        throw new Error(`Canary ${label} command failed (exit ${code}); see sanitized workflow output`)
      }
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) stop()
      await child.exited
    }
  }
}

export async function cleanupCanaryRun(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  request: CanaryRequest = fetch,
) {
  const context = canaryContext(env, platform)
  if ((await realpath(context.temp)) !== context.temp) throw new Error("Canary runner directory must be canonical")
  const output = await realpath(context.output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new Error("Canary cleanup directory is unavailable")
  })
  if (!output) return 0
  if (output !== context.output) throw new Error("Canary cleanup directory must be canonical")
  try {
    const report = await readCanaryLocalJson(output, "report.json")
    const receipt = recoveryReceipt(report, context)
    if (report.cleanupComplete === true) {
      if (
        !cleanupComplete(report.cleanup as CanaryCleanupResult | undefined) ||
        (Array.isArray(report.manualCleanup) && report.manualCleanup.length > 0)
      )
        throw new Error("Canary cleanup completion receipt is invalid")
      return 0
    }
    try {
      const secrets = receipt.workerDeployed ? await readCanaryLocalJson(output, "secrets.json") : undefined
      if (
        receipt.workerDeployed &&
        (typeof secrets?.CANARY_ADMIN_TOKEN !== "string" || !validControlToken(secrets.CANARY_ADMIN_TOKEN))
      )
        throw new Error("Canary cleanup credentials are invalid")
      const cleanup = await cleanupCanaryResourceReceipt({
        accountID: env.CLOUDFLARE_ACCOUNT_ID ?? "",
        token: env.CLOUDFLARE_API_TOKEN ?? "",
        receipt,
        request,
        ...(receipt.workerDeployed
          ? { purge: () => stopAndPurge(report.origin as string, secrets!.CANARY_ADMIN_TOKEN as string, request) }
          : {}),
      })
      report.cleanup = cleanup
      report.cleanupComplete =
        cleanupComplete(cleanup) &&
        report.provisioningComplete === true &&
        (!Array.isArray(report.manualCleanup) || report.manualCleanup.length === 0)
      report.ok = !!report.probe && report.cleanupComplete
      if (report.provisioningComplete !== true)
        report.error = "Provisioning was interrupted; unconfirmed creations require manual reconciliation"
    } catch {
      report.cleanupComplete = false
      report.ok = false
      report.error = "Independent canary cleanup failed; private diagnostics are suppressed"
    }
    await saveCanaryReport(output, report)
    console.log(JSON.stringify({ name: context.name, cleanupComplete: report.cleanupComplete }))
    return report.cleanupComplete === true ? 0 : 1
  } finally {
    await unlink(join(output, "secrets.json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw new Error("Canary private credentials could not be removed")
    })
  }
}

function recoveryReceipt(report: Record<string, unknown>, context: ReturnType<typeof canaryContext>): CanaryReceipt {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (
    report.name !== context.name ||
    report.version !== context.version ||
    typeof report.ok !== "boolean" ||
    typeof report.cleanupComplete !== "boolean" ||
    typeof report.provisioningComplete !== "boolean" ||
    typeof report.r2BucketCreated !== "boolean" ||
    typeof report.workerDeployed !== "boolean" ||
    (report.databaseID !== undefined && (typeof report.databaseID !== "string" || !uuid.test(report.databaseID))) ||
    (report.containerApplicationID !== undefined &&
      (typeof report.containerApplicationID !== "string" || !uuid.test(report.containerApplicationID))) ||
    (report.cleanup !== undefined &&
      (typeof report.cleanup !== "object" ||
        report.cleanup === null ||
        (report.cleanup as Record<string, unknown>).name !== context.name)) ||
    (report.manualCleanup !== undefined &&
      (!Array.isArray(report.manualCleanup) || report.manualCleanup.some((value) => typeof value !== "string")))
  )
    throw new Error("Canary recovery receipt is invalid or belongs to another run")
  if (report.workerDeployed) {
    if (
      typeof report.origin !== "string" ||
      !new RegExp(`^https://${context.name}\\.[a-z0-9-]+\\.workers\\.dev$`).test(report.origin) ||
      !report.databaseID ||
      report.r2BucketCreated !== true
    )
      throw new Error("Canary deployed receipt is incomplete or has an invalid origin")
  }
  return {
    name: context.name,
    databaseID: report.databaseID as string | undefined,
    r2BucketCreated: report.r2BucketCreated,
    workerDeployed: report.workerDeployed,
    containerApplicationID: report.containerApplicationID as string | undefined,
  }
}

function cleanupComplete(cleanup?: CanaryCleanupResult) {
  return (
    !!cleanup &&
    Array.isArray(cleanup.failures) &&
    cleanup.failures.length === 0 &&
    Array.isArray(cleanup.manualCleanup) &&
    cleanup.manualCleanup.length === 0
  )
}

async function readCanaryLocalJson(output: string, name: "report.json" | "secrets.json") {
  const path = join(output, name)
  try {
    if ((await realpath(path)) !== path) throw new Error("Noncanonical canary receipt")
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 65_536) throw new Error("Invalid canary receipt file")
      const bytes = Buffer.alloc(65_537)
      let size = 0
      while (size < bytes.length) {
        const chunk = await file.read(bytes, size, bytes.length - size, size)
        if (chunk.bytesRead === 0) break
        size += chunk.bytesRead
      }
      if (size > 65_536) throw new Error("Canary receipt exceeded its bound")
      const value: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"))
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid canary receipt")
      return value as Record<string, unknown>
    } finally {
      await file.close()
    }
  } catch {
    throw new Error("Canary private JSON file is missing or invalid")
  }
}

async function saveCanaryReport(output: string, report: Record<string, unknown>) {
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (Buffer.byteLength(text) > 65_536) throw new Error("Canary report exceeded its bound")
  await writeFile(join(output, "report.pending.json"), text, { mode: 0o600 })
  await rename(join(output, "report.pending.json"), join(output, "report.json"))
}

async function stopAndPurge(origin: string, adminToken: string, request: CanaryRequest = fetch) {
  const deadline = AbortSignal.timeout(270_000)
  const stopped = (receipt: { state?: { status?: string } }) =>
    ["stopped", "stopped_with_code"].includes(receipt.state?.status ?? "")
  const first = await admin<{ state?: { status?: string } }>("/__canary/state", "GET")
  if (!stopped(first)) await admin("/__canary/stop", "POST")
  for (let attempt = 0; attempt < 130; attempt++) {
    const receipt = await admin<{ state?: { status?: string } }>("/__canary/state", "GET")
    if (stopped(receipt)) {
      await admin("/__canary/purge", "POST")
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error("Canary did not stop; backend resources must not be deleted")

  async function admin<T = unknown>(path: string, method: string): Promise<T> {
    deadline.throwIfAborted()
    const response = await request(`${origin}${path}`, {
      method,
      headers: { "x-mongolgpt-canary-token": adminToken },
      redirect: "error",
      signal: AbortSignal.any([deadline, AbortSignal.timeout(30_000)]),
    }).catch(() => {
      throw new Error("Canary cleanup request failed; private diagnostics are suppressed")
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Canary cleanup endpoint returned HTTP ${response.status}`)
    }
    return readCanaryJson<T>(response)
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args.length === 1 && args[0] !== "--cleanup-only"))
      throw new Error("Unsupported canary mode")
    process.exitCode = args[0] === "--cleanup-only" ? await cleanupCanaryRun(process.env) : await run()
  } catch {
    console.error("Canary operation failed; private diagnostics are suppressed")
    process.exitCode = 1
  }
}
