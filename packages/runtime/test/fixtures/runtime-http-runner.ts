import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { unstable_startWorker } from "wrangler"

const root = await mkdtemp(fileURLToPath(new URL("../../.tmp/runtime-http-", import.meta.url)))
const config = join(root, "wrangler.json")
await writeFile(
  config,
  JSON.stringify({
    name: "local-runtime-http",
    main: fileURLToPath(new URL("./runtime-http-worker.ts", import.meta.url)),
    compatibility_date: "2026-07-18",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      MONGOLGPT_RUNTIME_SECRET: "synthetic-http-routing-secret-at-least-thirty-two-characters",
      SANDBOX_LOG_LEVEL: "error",
    },
    durable_objects: { bindings: [{ name: "Native", class_name: "NativeEndpoint" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["NativeEndpoint"] }],
  }),
)
const worker = await unstable_startWorker({
  config,
  envFiles: [],
  dev: {
    remote: false,
    watch: false,
    inspector: false,
    logLevel: "none",
    registry: undefined,
    persist: false,
    server: { hostname: "127.0.0.1", port: 0 },
  },
})
try {
  await worker.ready
  const fetch = (path: string) => worker.fetch(`http://localhost${path}`, { signal: AbortSignal.timeout(15_000) })
  assert.deepEqual(await (await fetch("/legacy")).json(), { code: "transport", status: null })
  assert.deepEqual(await (await fetch("/health")).json(), { code: "ready", status: 200 })
  const recovered = (await (await fetch("/retry-health")).json()) as {
    readiness: unknown
    invocations: number
    elapsed: number
  }
  assert.deepEqual(recovered.readiness, { code: "ready", status: 200 })
  assert.equal(recovered.invocations, 2)
  assert.ok(recovered.elapsed < 2_000)
  const exhausted = (await (await fetch("/retry-deadline")).json()) as typeof recovered
  assert.deepEqual(exhausted.readiness, { code: "http_status", status: 500 })
  assert.ok(exhausted.invocations >= 1 && exhausted.invocations <= 2)
  assert.ok(exhausted.elapsed >= 549 && exhausted.elapsed < 2_000)
  assert.deepEqual(await (await fetch("/post")).json(), {
    method: "POST",
    body: "synthetic-request-body",
    url: "http://localhost/session?directory=%2Fworkspace",
  })
  assert.equal((await fetch("/invalid-marker")).status, 400)
  assert.deepEqual(await (await fetch("/aborted")).json(), { name: "OperationInterruptedError", executed: false })
  console.log("RUNTIME_HTTP_RPC_PROOF_PASS")
} finally {
  await worker.dispose()
}
