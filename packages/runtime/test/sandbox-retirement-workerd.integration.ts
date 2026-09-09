import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { unstable_splitSqlQuery, unstable_startWorker } from "wrangler"

const root = await mkdtemp(join(tmpdir(), "mongolgpt-retirement-worker-"))
let server: Awaited<ReturnType<typeof unstable_startWorker>> | undefined
let assertions = 0
const marker = {
  accountID: "acc_retirement_probe",
  workspaceID: "wrk_retirement_probe",
  requestID: "del_retirement_probe",
}
type State = { instance: string; running: boolean; stops: number; seal: typeof marker | null }

try {
  console.log("SANDBOX_RETIREMENT_PHASE starting")
  const config = join(root, "wrangler.jsonc")
  await writeFile(
    config,
    JSON.stringify({
      name: "mongolgpt-retirement-local-test",
      main: fileURLToPath(new URL("./fixtures/sandbox-retirement-worker.ts", import.meta.url)),
      compatibility_date: "2026-07-18",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        MONGOLGPT_RUNTIME_SECRET: "synthetic-retirement-test-secret-at-least-thirty-two-characters",
        SANDBOX_LOG_LEVEL: "error",
      },
      durable_objects: { bindings: [{ name: "Sandbox", class_name: "RetirementSandbox" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["RetirementSandbox"] }],
      d1_databases: [
        { binding: "HISTORY", database_name: "retirement-test", database_id: "00000000-0000-4000-8000-000000000001" },
      ],
      dev: { ip: "127.0.0.1", port: 0, inspector_port: 0 },
    }),
  )
  server = await unstable_startWorker({
    config,
    dev: {
      remote: false,
      watch: false,
      persist: false,
      inspector: false,
      logLevel: "none",
      registry: undefined,
      server: { hostname: "127.0.0.1", port: 0 },
    },
  })
  await server.ready
  console.log("SANDBOX_RETIREMENT_PHASE migrations")
  for (const file of [
    "0001_history.sql",
    "0002_history_checkpoint.sql",
    "0003_file_revision.sql",
    "0004_account_retirement.sql",
    "0005_backup_write_fences.sql",
  ]) {
    const sql = await readFile(fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)), "utf8")
    await call("/migrate", unstable_splitSqlQuery(sql))
  }
  const before = await call<State>("/prepare")
  equal(before.running, true, "fixture container was not running")
  equal(before.seal, null, "fresh DO already retired")
  equal(
    (await call<{ error: string }>("/retire", undefined, 409)).error.includes("эхлээгүй"),
    true,
    "missing D1 fence accepted",
  )
  equal((await call<State>("/state")).running, true, "failed preflight changed container")
  await call("/fence")
  equal(
    (await call<{ error: string }>("/wrong-scope", undefined, 409)).error.includes("хүрээ"),
    true,
    "real DO scope mismatch accepted",
  )
  equal((await call<State>("/state")).seal, null, "wrong scope sealed the correct DO")
  console.log("SANDBOX_RETIREMENT_PHASE retirement")
  for (const receipt of await Promise.all([call("/retire"), call("/retire")]))
    equal(receipt, { ...marker, stopped: true }, "invalid stop receipt")
  const stopped = await call<State>("/state")
  equal(stopped.running, false, "platform boundary not stopped")
  equal(stopped.seal, marker, "durable seal missing")
  equal(await call("/denied"), Array(7).fill(true), "retired operation was admitted")
  await call("/restart", undefined, 409)
  const restarted = await call<State>("/state")
  equal(restarted.instance !== before.instance, true, "DO did not actually reinstantiate")
  equal(restarted.seal, marker, "seal did not survive real DO restart")
  equal(await call("/denied"), Array(7).fill(true), "restarted DO admitted retired operations")
  equal(await call("/retire"), { ...marker, stopped: true }, "retry after restart failed")
  const retried = await call<State>("/state")
  equal(retried.running, false, "retry restarted the container")
  equal(retried.stops > stopped.stops, true, "restart retry did not confirm container termination again")
  console.log(
    `SANDBOX_RETIREMENT_RESULT ${JSON.stringify({ ok: true, assertions, realD1: true, realDurableStorage: true, realDOReinstantiation: true, simulatedContainer: true })}`,
  )
} finally {
  try {
    await server?.dispose()
  } finally {
    const inside = relative(resolve(tmpdir()), resolve(root))
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("retirement test cleanup escaped temp root")
    await rm(root, { recursive: true, force: true })
  }
}

async function call<T = unknown>(path: string, body?: string[], status = 200): Promise<T> {
  const response = await server!.fetch(`http://localhost${path}`, {
    method: "POST",
    ...(body && { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    signal: AbortSignal.timeout(10_000),
  })
  const result = await response.json()
  equal(response.status, status, `${path} returned unexpected HTTP ${response.status}: ${JSON.stringify(result)}`)
  return result as T
}

function equal(actual: unknown, expected: unknown, message: string) {
  assertions++
  assert.deepEqual(actual, expected, message)
}
