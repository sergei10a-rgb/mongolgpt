import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const tempBase = resolve(".tmp")
await mkdir(tempBase, { recursive: true })
const root = await mkdtemp(join(tempBase, "mongolgpt-usage-queue-"))
process.env.XDG_CONFIG_HOME = join(root, "xdg-config")
process.env.XDG_CACHE_HOME = join(root, "xdg-cache")
process.env.WRANGLER_CACHE_DIR = join(root, "wrangler-cache")
process.env.WRANGLER_LOG_PATH = join(root, "wrangler.log")
const { unstable_startWorker } = await import("wrangler")
const { build } = createRequire(import.meta.resolve("wrangler"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<unknown>
}
let server: Awaited<ReturnType<typeof unstable_startWorker>> | undefined
let assertions = 0

type State = {
  keys: { dev: string | null; production: string | null; legacy: string | null }
  receipts: { legacy: string | null; wrongStage: string | null }
  readiness: { id: string; state: string; summary: string }
  status: string
}

try {
  console.log("USAGE_QUEUE_PHASE start")
  const config = join(root, "wrangler.jsonc")
  const bundle = join(root, "worker.mjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/usage-queue-worker.ts", import.meta.url))],
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
      name: "mongolgpt-usage-queue-local-test",
      main: bundle,
      compatibility_date: "2026-07-18",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        SST_RESOURCE_App: JSON.stringify({ name: "mongolgpt", stage: "dev" }),
      },
      kv_namespaces: [
        {
          binding: "UsageQueueReadiness",
          id: "00000000000000000000000000000001",
        },
        {
          binding: "UsageQueueReceipts",
          id: "00000000000000000000000000000002",
        },
      ],
      queues: {
        producers: [{ binding: "UsageQueue", queue: "mongolgpt-usage-queue-local-test" }],
        consumers: [
          {
            queue: "mongolgpt-usage-queue-local-test",
            max_batch_size: 1,
            max_batch_timeout: 1,
            max_retries: 1,
          },
        ],
      },
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

  const empty = await call<State>("/state")
  equal(empty.keys, { dev: null, production: null, legacy: null }, "fixture KV started with readiness evidence")
  equal(empty.receipts, { legacy: null, wrongStage: null }, "fixture receipt KV started with processed markers")
  equal(empty.readiness.state, "degraded", "missing usage queue evidence was not degraded")

  console.log("USAGE_QUEUE_PHASE stale_messages")
  await call("/legacy")
  await call("/wrong-stage")
  const stale = await stableState((state) => state.receipts.legacy !== null && state.receipts.wrongStage !== null)
  equal(JSON.parse(stale.receipts.legacy!), { processed: true }, "legacy v1 message did not finish production consumer")
  equal(
    JSON.parse(stale.receipts.wrongStage!),
    { processed: true },
    "wrong-stage message did not finish production consumer",
  )
  equal(stale.keys.legacy, null, "legacy v1 readiness key was written after production consumer completed")
  equal(
    stale.keys.production,
    null,
    "wrong-stage heartbeat wrote production evidence after production consumer completed",
  )
  equal(stale.keys.dev, null, "stale messages wrote dev evidence after production consumer completed")
  equal(stale.readiness.state, "degraded", "stale messages turned missing dev evidence healthy before v2")

  console.log("USAGE_QUEUE_PHASE heartbeat")
  await call("/scheduled")
  const healthy = await stableState((state) => state.readiness.state === "healthy" && state.keys.dev !== null)
  const evidence = JSON.parse(healthy.keys.dev!)
  equal(evidence.version, 2, "readiness evidence was not v2")
  equal(evidence.stage, "dev", "readiness evidence was not stage-bound to dev")
  equal(typeof evidence.id, "string", "readiness evidence id missing")
  equal(typeof evidence.sentAt, "number", "readiness evidence sentAt missing")
  equal(typeof evidence.processedAt, "number", "readiness evidence processedAt missing")
  equal(evidence.processedAt >= evidence.sentAt, true, "readiness evidence processed before send")
  equal(healthy.keys.production, null, "scheduled dev heartbeat wrote production evidence")
  equal(healthy.keys.legacy, null, "scheduled dev heartbeat wrote legacy v1 key")
  equal(healthy.readiness.state, "healthy", "admin queue check did not become healthy")

  console.log(
    `USAGE_QUEUE_RESULT ${JSON.stringify({
      ok: true,
      assertions,
      realQueue: true,
      realKV: true,
      realScheduledHandler: true,
      realAdminReadiness: true,
    })}`,
  )
} finally {
  try {
    await server?.dispose()
  } finally {
    const inside = relative(resolve(tempBase), resolve(root))
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("usage queue fixture escaped temp root")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function call<T = unknown>(path: string, status = 200): Promise<T> {
  const response = await server!.fetch(`http://localhost${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json()
  equal(response.status, status, `${path} returned ${response.status}: ${JSON.stringify(result)}`)
  return result as T
}

async function stableState(predicate: (state: State) => boolean): Promise<State> {
  const deadline = Date.now() + 10_000
  let latest = await call<State>("/state")
  while (!predicate(latest) && Date.now() < deadline) {
    await delay(100)
    latest = await call<State>("/state")
  }
  assert.equal(predicate(latest), true, `timed out waiting for usage queue state: ${JSON.stringify(latest)}`)
  return latest
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function equal(actual: unknown, expected: unknown, message: string) {
  assertions++
  assert.deepEqual(actual, expected, message)
}
