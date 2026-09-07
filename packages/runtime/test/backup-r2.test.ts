import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

test("runs real local R2 encrypted SQLite archive store checks under Node", async () => {
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for the local R2 integration harness")
  const transientRoot = fileURLToPath(new URL("../.tmp/", import.meta.url))
  await mkdir(transientRoot, { recursive: true })
  const bundle = await mkdtemp(join(transientRoot, "backup-r2-native-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./fixtures/backup-native.ts", import.meta.url))],
      outdir: bundle,
      naming: "backup-native.mjs",
      target: "node",
    })
    if (!build.success) throw new Error(`backup native build failed: ${build.logs.join("\n")}`)
    const integration = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./backup-r2.integration.ts", import.meta.url))],
      outdir: bundle,
      naming: "backup-r2.integration.mjs",
      target: "node",
      packages: "external",
    })
    if (!integration.success) throw new Error(`backup R2 integration build failed: ${integration.logs.join("\n")}`)
    const output = await runNode(
      node,
      join(bundle, "backup-r2.integration.mjs"),
      [join(bundle, "backup-native.mjs"), fileURLToPath(new URL("./fixtures/backup-r2.jsonc", import.meta.url))],
      120_000,
    )
    const resultLine = output.stdout.split(/\r?\n/).find((line) => line.startsWith("BACKUP_R2_RESULT "))
    expect(resultLine).toBeDefined()
    const result = JSON.parse(resultLine!.slice("BACKUP_R2_RESULT ".length))
    expect(result.ok).toBe(true)
    expect(typeof result.assertions).toBe("number")
    expect(result.assertions).toBeGreaterThanOrEqual(65)
    console.log(`Local R2 backup: ${result.assertions} assertions passed`)
  } finally {
    const inside = relative(transientRoot, bundle)
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("backup integration cleanup escaped transient root")
    await rm(bundle, { recursive: true, force: true })
  }
}, 160_000)

test("executes the backup store and tenant key derivation inside workerd", async () => {
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for Worker integration")
  const transientRoot = fileURLToPath(new URL("../.tmp/", import.meta.url))
  await mkdir(transientRoot, { recursive: true })
  const bundle = await mkdtemp(join(transientRoot, "backup-worker-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./backup-worker.integration.ts", import.meta.url))],
      outdir: bundle,
      naming: "backup-worker.integration.mjs",
      target: "node",
      packages: "external",
    })
    if (!build.success) throw new Error(`Worker integration build failed: ${build.logs.join("\n")}`)
    const output = await runNode(
      node,
      join(bundle, "backup-worker.integration.mjs"),
      [fileURLToPath(new URL("./fixtures/backup-worker.ts", import.meta.url))],
      60_000,
    )
    const line = output.stdout.split(/\r?\n/).find((line) => line.startsWith("BACKUP_WORKER_RESULT "))
    expect(line).toBeDefined()
    const result = JSON.parse(line!.slice("BACKUP_WORKER_RESULT ".length))
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(false)
    expect(result.assertions).toBeGreaterThanOrEqual(12)
    console.log(`Worker R2 backup: ${result.assertions} assertions passed`)
  } finally {
    const inside = relative(transientRoot, bundle)
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("Worker cleanup escaped transient root")
    await rm(bundle, { recursive: true, force: true })
  }
}, 70_000)

async function runNode(node: string, script: string, args: string[], timeoutMs: number) {
  const child = spawn(node, [script, ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    windowsHide: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const output = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)
    child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-16000)))
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-16000)))
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      if (timedOut) return reject(new Error(`${script} timed out`))
      resolve({ code, signal, stdout, stderr })
    })
  })

  if (output.code !== 0 || output.signal !== null) {
    throw new Error(
      `${script} failed (code=${output.code}, signal=${output.signal})\nstdout: ${output.stdout.slice(-2000)}\nstderr: ${output.stderr.slice(-2000)}`,
    )
  }
  return output
}
