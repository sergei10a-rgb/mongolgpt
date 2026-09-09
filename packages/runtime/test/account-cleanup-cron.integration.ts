import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { unstable_splitSqlQuery, unstable_startWorker } from "wrangler"

const { build } = createRequire(import.meta.resolve("wrangler"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<unknown>
}

const root = await mkdtemp(join(tmpdir(), "mongolgpt-cleanup-cron-"))
let server: Awaited<ReturnType<typeof unstable_startWorker>> | undefined
let assertions = 0
type State = {
  account: { time_deleted: number | null; auth_version: number } | null
  request: { id: string; status: string } | null
  cleanup: {
    workspace_ids: string
    time_runtime_completed: number | null
    time_completed: number | null
    last_error_code: string | null
    attempts: number
  } | null
  user: { name: string; account_id: string | null }
  auth: number
  key: { key: string; time_deleted: number | null }
  provider: { credentials: string }
  runtime: { phase: number } | null
  content: { data: string } | null
  backups: number
  sandboxes: { running: boolean; stops: number; seal: { accountID: string; requestID: string } | null }[]
}

try {
  console.log("ACCOUNT_CLEANUP_CRON_PHASE start")
  const config = join(root, "wrangler.jsonc")
  const bundle = join(root, "worker.mjs")
  // Match the production resource export and prebundle schema *.sql.ts imports
  // before Wrangler's additional-module rules can classify them as SQL assets.
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/account-cleanup-cron-worker.ts", import.meta.url))],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    conditions: ["production", "workerd"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*"],
  })
  await writeFile(
    config,
    JSON.stringify({
      name: "mongolgpt-cleanup-cron-local-test",
      main: bundle,
      compatibility_date: "2026-07-18",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        MONGOLGPT_RUNTIME_SECRET: "synthetic-cron-test-runtime-secret-at-least-thirty-two-characters",
        MONGOLGPT_RUNTIME_ACCOUNT_CLEANUP: "true",
        SANDBOX_LOG_LEVEL: "error",
      },
      durable_objects: { bindings: [{ name: "Sandbox", class_name: "RetirementSandbox" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["RetirementSandbox"] }],
      services: [
        {
          binding: "RuntimeAccountCleanup",
          service: "mongolgpt-cleanup-cron-local-test",
          entrypoint: "RuntimeAccountCleanup",
        },
      ],
      d1_databases: [
        { binding: "Database", database_name: "cleanup-console", database_id: "00000000-0000-4000-8000-000000000001" },
        { binding: "HISTORY", database_name: "cleanup-runtime", database_id: "00000000-0000-4000-8000-000000000002" },
      ],
      r2_buckets: [{ binding: "RUNTIME_BACKUPS", bucket_name: "cleanup-cron-backups" }],
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
  console.log("ACCOUNT_CLEANUP_CRON_PHASE console_migrations")
  const directory = fileURLToPath(new URL("../../console/core/migrations-d1/", import.meta.url))
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!(await readdir(join(directory, entry.name))).includes("migration.sql")) continue
    await call(
      "/migrate-console",
      unstable_splitSqlQuery(await readFile(join(directory, entry.name, "migration.sql"), "utf8")),
    )
  }
  const requested = await call<{ id: string; status: string }>("/seed-console")
  equal(requested.status, "requested", "real deletion admission failed")
  await call("/cron", undefined, 409)
  equal(
    await call("/preflight-state"),
    {
      account: { time_deleted: null, auth_version: 0 },
      request: { status: "requested" },
    },
    "unready runtime retired the console account",
  )

  console.log("ACCOUNT_CLEANUP_CRON_PHASE runtime_migrations")
  const migrations = fileURLToPath(new URL("../migrations/", import.meta.url))
  for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort())
    await call("/migrate-runtime", unstable_splitSqlQuery(await readFile(join(migrations, file), "utf8")))
  await call("/seed-runtime")
  const neighbor = await call<State>("/neighbor")
  console.log("ACCOUNT_CLEANUP_CRON_PHASE runtime_failure")
  await call("/cron")
  const partial = await call<State>("/state")
  equal(partial.request, { id: requested.id, status: "processing" }, "failed runtime was reported complete")
  equal(partial.account!.auth_version, 1, "retirement did not revoke sessions")
  equal(typeof partial.account!.time_deleted, "number", "retired account stayed active")
  equal(typeof partial.key.time_deleted, "number", "key remained usable during cleanup")
  equal(partial.cleanup!.time_runtime_completed, null, "failed runtime got completion timestamp")
  equal(partial.cleanup!.last_error_code, "runtime_cleanup_failed", "wrong failure classification")
  equal(JSON.parse(partial.cleanup!.workspace_ids), ["wrk_cron_cleanup"], "console workspace inventory mismatch")
  equal(
    partial.user,
    { name: "Private fixture name", account_id: "acc_cron_cleanup" },
    "identity scrubbed before runtime acknowledgement",
  )
  equal(partial.auth, 1, "auth identity removed before runtime receipt")
  equal(partial.provider.credentials, "private fixture credentials", "provider was partially scrubbed")
  equal(partial.runtime, { phase: 4 }, "runtime failure did not preserve resumable progress")
  equal(partial.content, { data: "private fixture history" }, "injected failure did not hit real history erasure")
  equal(partial.backups, 0, "R2 content survived the completed backup phase")
  equal(
    partial.sandboxes.map((s) => s.running),
    [false, false],
    "current/historical sandbox still running",
  )
  equal(
    partial.sandboxes.every((s) => s.seal?.requestID === requested.id),
    true,
    "sandbox retirement request mismatch",
  )

  console.log("ACCOUNT_CLEANUP_CRON_PHASE console_failure")
  await call("/console-failure")
  await call("/cron")
  const acknowledged = await call<State>("/state")
  equal(acknowledged.request!.status, "processing", "failed console scrub was reported complete")
  equal(acknowledged.runtime, { phase: 5 }, "runtime did not finish before console scrub")
  equal(acknowledged.content, null, "runtime history remained after receipt")
  equal(typeof acknowledged.cleanup!.time_runtime_completed, "number", "runtime acknowledgement not saved")
  equal(acknowledged.cleanup!.time_completed, null, "failed console transaction got completion timestamp")
  equal(acknowledged.cleanup!.last_error_code, "account_cleanup_failed", "wrong console failure classification")
  equal(acknowledged.user, partial.user, "failed console batch partially removed identity")
  equal(acknowledged.auth, 1, "failed console batch removed auth identity")
  equal(acknowledged.provider, partial.provider, "failed console batch removed credentials")

  console.log("ACCOUNT_CLEANUP_CRON_PHASE completion")
  await call("/allow-completion")
  await call("/cron")
  const completed = await call<State>("/state")
  equal(completed.request!.status, "completed", "real cron did not complete deletion")
  equal(completed.cleanup!.attempts, 3, "durable retry count is wrong")
  equal(
    completed.cleanup!.time_runtime_completed,
    acknowledged.cleanup!.time_runtime_completed,
    "acknowledged runtime replayed",
  )
  equal(typeof completed.cleanup!.time_completed, "number", "missing console completion receipt")
  equal(completed.cleanup!.last_error_code, null, "completed job retained failure")
  equal(completed.user, { name: "", account_id: null }, "user identity remains")
  equal(completed.auth, 0, "auth identity remains")
  equal(completed.key.key.startsWith("revoked:"), true, "key material remains")
  equal(completed.provider.credentials, "", "provider credentials remain")
  equal(
    completed.sandboxes.map((s) => s.stops),
    partial.sandboxes.map((s) => s.stops),
    "acknowledged sandbox stops replayed",
  )
  await call("/cron")
  equal(await call("/state"), completed, "empty subsequent cron changed completed deletion")
  equal(await call("/neighbor"), neighbor, "neighbor account or same-name runtime workspace changed")

  await call("/purge")
  const purged = await call<State>("/state")
  equal(purged.account, null, "account shell was not purged after retention")
  equal(purged.request, null, "purged operational request still links old account")
  equal(purged.cleanup, null, "completed operational cleanup receipt was not purged")
  equal(purged.runtime, { phase: 5 }, "permanent runtime retirement receipt disappeared")
  equal(
    purged.sandboxes.every((s) => s.seal?.accountID === "acc_cron_cleanup"),
    true,
    "permanent sandbox seal disappeared",
  )
  equal(await call("/neighbor"), neighbor, "retention purge changed another account")
  console.log(
    `ACCOUNT_CLEANUP_CRON_RESULT ${JSON.stringify({ ok: true, assertions, realConsoleD1: true, realRuntimeD1: true, realR2: true, realScheduledHandler: true, realServiceRPC: true, simulatedContainer: true })}`,
  )
} finally {
  try {
    await server?.dispose()
  } finally {
    const inside = relative(resolve(tmpdir()), resolve(root))
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("cron fixture escaped temp root")
    await rm(root, { recursive: true, force: true })
  }
}

async function call<T = unknown>(path: string, body?: string[], status = 200): Promise<T> {
  const response = await server!.fetch(`http://localhost${path}`, {
    method: "POST",
    ...(body && { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json()
  equal(response.status, status, `${path} returned ${response.status}: ${JSON.stringify(result)}`)
  return result as T
}

function equal(actual: unknown, expected: unknown, message: string) {
  assertions++
  assert.deepEqual(actual, expected, message)
}
