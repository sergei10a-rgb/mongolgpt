import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { deriveCheckpointControlToken, checkpointControlHeader } from "@mongolgpt/runtime-auth/control"

// Run with Node 22+; the native reporter is compiled with the supplied Bun executable.
const { unstable_startWorker } = await import("wrangler")
const root = await mkdtemp(fileURLToPath(new URL("../.tmp/startup-diagnostic-", import.meta.url)))
const nativeHandoff = process.platform === "linux" && process.getuid?.() === 0
const assertions = nativeHandoff ? 23 : 18
const secret = randomBytes(32).toString("hex")
const admin = randomBytes(32).toString("hex")
const scope = { accountID: "account_cloudflare_canary", workspaceID: "wrk_cloudflare_canary" }
const token = await deriveCheckpointControlToken(secret, scope)
const config = join(root, "wrangler.json")
await writeFile(
  config,
  JSON.stringify({
    name: "mongolgpt-startup-diagnostic-local",
    main: fileURLToPath(new URL("../test/fixtures/startup-diagnostic-worker.ts", import.meta.url)),
    compatibility_date: "2026-07-18",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      STAGE: "dev",
      CANARY_RUN_ID: "mgpt-canary-123-1",
      CANARY_ADMIN_TOKEN: admin,
      MONGOLGPT_RUNTIME_SECRET: secret,
    },
    durable_objects: { bindings: [{ name: "Sandbox", class_name: "StartupEvidence" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["StartupEvidence"] }],
    dev: { ip: "127.0.0.1", port: 0, inspector_port: 0 },
  }),
  { mode: 0o600 },
)
const options = {
  config,
  envFiles: [],
  dev: {
    remote: false,
    watch: false,
    persist: join(root, "state"),
    inspector: false,
    logLevel: "none" as const,
    registry: undefined,
    server: { hostname: "127.0.0.1", port: 0 },
  },
}
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined
let phase = "initial_start"
try {
  worker = await unstable_startWorker(options)
  await bounded(worker.ready)
  const receipt = () =>
    worker!
      .fetch("http://127.0.0.1/__test/receipt", {
        headers: { "x-test-admin-token": admin },
        signal: AbortSignal.timeout(10_000),
      })
      .then((response) => response.json())
  phase = "initial_read"
  assert.equal(await receipt(), null)
  const body = JSON.stringify({
    phase: "retire_root",
    code: "EXDEV",
    overlay: true,
    workspaceMount: false,
    exitCode: null,
  })
  phase = "unauthorized_write"
  const denied = await worker.fetch("http://127.0.0.1/v1/startup-diagnostic", {
    method: "POST",
    headers: { "x-test-admin-token": admin, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(denied.status, 403)
  await denied.arrayBuffer()
  phase = "unauthorized_read"
  assert.equal(await receipt(), null)
  phase = "authorized_write"
  const accepted = await worker.fetch("http://127.0.0.1/v1/startup-diagnostic", {
    method: "POST",
    headers: { "x-test-admin-token": admin, "content-type": "application/json", [checkpointControlHeader]: token },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(accepted.status, 204)
  await accepted.arrayBuffer()
  const expected = { bootCount: 1, diagnostic: JSON.parse(body) }
  phase = "authorized_read"
  assert.deepEqual(await receipt(), expected)
  await worker.dispose()
  worker = await unstable_startWorker(options)
  await bounded(worker.ready)
  phase = "restart_read"
  assert.deepEqual(await receipt(), expected)
  const bun = process.env.MONGOLGPT_TEST_BUN
  if (!bun) throw new Error("MONGOLGPT_TEST_BUN must name the local Bun executable")
  const executable = join(root, process.platform === "win32" ? "reporter.exe" : "reporter")
  const entry = fileURLToPath(new URL("../../mongolgpt/test/fixture/startup-diagnostic-native.ts", import.meta.url))
  phase = "compile_reporter"
  await run(bun, ["build", entry, "--compile", "--outfile", executable])
  phase = "native_reporter"
  const result = JSON.parse(
    await run(
      executable,
      [],
      JSON.stringify({
        origin: (await worker.url).origin,
        token,
        admin,
        missingRoot: join(root, "nonexistent-workspace"),
      }),
    ),
  )
  assert.deepEqual(result, { reported: true, phase: "validate_root", code: "ENOENT" })
  const native = (await receipt()) as { bootCount: number; diagnostic: { phase: string; code: string } }
  assert.equal(native.bootCount, 1)
  assert.equal(native.diagnostic.phase, "validate_root")
  assert.equal(native.diagnostic.code, "ENOENT")
  await worker.dispose()
  worker = await unstable_startWorker(options)
  await bounded(worker.ready)
  assert.deepEqual(await receipt(), native)
  phase = "native_child_exit"
  const childExit = JSON.parse(
    await run(
      executable,
      [],
      JSON.stringify({
        origin: (await worker.url).origin,
        token,
        admin,
        nativeExit: true,
      }),
    ),
  )
  assert.deepEqual(childExit, { reported: true, completed: true, exitCode: 17 })
  const fatal = (await receipt()) as {
    bootCount: number
    diagnostic: { phase: string; code: string; exitCode: number }
  }
  assert.equal(fatal.bootCount, 1)
  assert.equal(fatal.diagnostic.phase, "native_exit")
  assert.equal(fatal.diagnostic.code, "EACCES")
  assert.equal(fatal.diagnostic.exitCode, 17)
  assert.equal(JSON.stringify(fatal).includes("private-test"), false)
  await worker.dispose()
  worker = await unstable_startWorker(options)
  await bounded(worker.ready)
  phase = "native_child_restart_read"
  assert.deepEqual(await receipt(), fatal)
  if (nativeHandoff) {
    phase = "native_handoff_rejection"
    const handoff = JSON.parse(
      await run(
        executable,
        [],
        JSON.stringify({
          origin: (await worker.url).origin,
          token,
          admin,
          nativeHandoff: true,
        }),
      ),
    )
    assert.deepEqual(handoff, { reported: true, completed: true, exitCode: 1 })
    const rejected = (await receipt()) as { diagnostic: { phase: string; code: string; exitCode: number } }
    assert.equal(rejected.diagnostic.phase, "native_exit")
    assert.equal(rejected.diagnostic.code, "handoff_cgroup_binding")
    assert.equal(rejected.diagnostic.exitCode, 1)
    await worker.dispose()
    worker = await unstable_startWorker(options)
    await bounded(worker.ready)
    assert.deepEqual(await receipt(), rejected)
  }
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        assertions,
        proxy: "actual-ContainerProxy",
        storage: "actual-DO-shared-persistence",
        retainedAfterRestart: true,
        compiledReporter: true,
        compiledChildExit: 17,
        compiledChildStderrClassification: "EACCES",
        actualHandoffRejection: nativeHandoff,
        reportedBeforeContainerCompletion: true,
        containerLifecycle: "not-tested",
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ passed: true, assertions, receipt: join(root, "result.json") }))
} catch (error) {
  console.error(JSON.stringify({ phase }))
  throw error
} finally {
  await worker?.dispose()
}

function run(executable: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    let bytes = 0
    const timer = setTimeout(() => child.kill(), 120_000)
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 65_536) child.kill()
      else stdout.push(chunk)
    })
    child.stderr.resume()
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`Native diagnostic test exited ${code}`))
      else resolve(Buffer.concat(stdout).toString("utf8"))
    })
    child.stdin.end(input)
  })
}

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Local worker readiness deadline")), 45_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
