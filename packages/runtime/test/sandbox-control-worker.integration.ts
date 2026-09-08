import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { unstable_startWorker } from "wrangler"

const runtimeSecret = process.env.MONGOLGPT_RUNTIME_SECRET
assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Node 22 or later is required")
const expectedToken = process.env.EXPECTED_SDK_TOKEN
assert.ok(runtimeSecret && /^[0-9a-f]{64}$/.test(runtimeSecret), "synthetic runtime secret must be 64 lowercase hex")
assert.ok(expectedToken && /^[0-9a-f]{64}$/.test(expectedToken), "synthetic SDK token must be 64 lowercase hex")
const workerScript = process.argv[2] ?? fileURLToPath(new URL("./fixtures/sandbox-control-worker.ts", import.meta.url))
assert.ok(isAbsolute(workerScript), "worker fixture path must be absolute")
const root = await mkdtemp(join(tmpdir(), "mongolgpt-sdk-worker-"))
let server: Awaited<ReturnType<typeof unstable_startWorker>> | undefined
let assertions = 0

try {
  console.log("SANDBOX_CONTROL_WORKER_PHASE starting")
  const config = join(root, "wrangler.jsonc")
  await writeFile(
    config,
    JSON.stringify({
      name: "mongolgpt-sdk-loopback-test",
      main: workerScript,
      compatibility_date: "2026-07-18",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        MONGOLGPT_RUNTIME_SECRET: runtimeSecret,
        EXPECTED_SDK_TOKEN: expectedToken,
        SANDBOX_LOG_LEVEL: "error",
      },
      durable_objects: { bindings: [{ name: "Sandbox", class_name: "SandboxControlWorker" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["SandboxControlWorker"] }],
      dev: { ip: "127.0.0.1", port: 0, inspector_port: 0 },
    }),
  )
  // createTestHarness routes outbound traffic through Node fetch, which cannot
  // upgrade WebSockets. The local Worker API keeps workerd's native transport.
  server = await bounded(
    unstable_startWorker({
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
    }),
    30_000,
    "worker startup deadline",
  )
  await bounded(server.ready, 30_000, "worker ready deadline")
  console.log("SANDBOX_CONTROL_WORKER_PHASE port_watch")
  // The Worker reserves 30s for RPC proof steps, 9s for cleanup, and 3s for receipts.
  const response = await bounded(
    server.fetch("http://localhost/probe", { method: "POST", signal: AbortSignal.timeout(45_000) }),
    45_000,
    "worker RPC deadline",
  )
  assert.ok(
    response.headers.get("content-type")?.includes("application/json"),
    `probe returned non-JSON HTTP ${response.status}`,
  )
  const result = (await response.json()) as {
    ok: boolean
    phase?: string
    firstMissing: boolean
    secondMissing: boolean
    listener: {
      sessionCreated: boolean
      started: boolean
      explicitSession: boolean
      portReady: boolean
      postWatchLookup: boolean
      killAttempted: boolean
      killCompleted: boolean
      stopped: boolean
      sessionDeleteAttempted: boolean
      sessionDeleted: boolean
    }
    receipts: {
      starts: number
      startTokenMatched: boolean
      onStarts: number
      healthProbes: number
      rpcAttempts: number
      rpcTokenMatched: boolean
      rpcUpgrades: number
    }
  }
  ok(
    response.status === 200 && result.ok === true,
    `worker RPC probe failed (HTTP ${response.status}, ${JSON.stringify(result)})`,
  )
  ok(result.firstMissing === true, "first actual SDK lookup did not return null")
  ok(result.secondMissing === true, "subsequent actual SDK lookup did not return null")
  ok(result.listener.sessionCreated === true, "actual SDK did not create the explicit persistent session")
  ok(result.listener.started === true, "actual SDK did not start the synthetic listener")
  // This local proof does not cover default-session creation at /workspace.
  ok(result.listener.explicitSession === true, "listener did not use its explicit persistent SDK session")
  ok(result.listener.portReady === true, "actual SDK RPC port-watch stream did not report ready")
  ok(result.listener.postWatchLookup === true, "actual SDK lookup failed after consuming the port-watch stream")
  ok(result.listener.killAttempted === true, "synthetic listener cleanup was not attempted")
  ok(result.listener.killCompleted === true, "actual SDK did not acknowledge synthetic listener kill")
  ok(result.listener.stopped === true, "actual SDK lookup did not confirm synthetic listener termination")
  ok(result.listener.sessionDeleteAttempted === true, "explicit session cleanup was not attempted")
  ok(result.listener.sessionDeleted === true, "actual SDK did not confirm explicit session deletion")
  ok(result.receipts.starts === 1, "cold boundary did not start exactly once")
  ok(result.receipts.startTokenMatched === true, "cold start token did not match")
  ok(result.receipts.onStarts >= 1, "actual subclass onStart did not complete")
  ok(result.receipts.healthProbes >= 1, "actual Containers readiness probe did not run")
  ok(result.receipts.rpcTokenMatched === true, "production RPC header did not match")
  ok(result.receipts.rpcAttempts === 1, "subsequent call did not reuse the RPC connection")
  ok(result.receipts.rpcUpgrades === 1, "real WebSocket upgrade did not complete")
  console.log(`SANDBOX_CONTROL_WORKER_RESULT ${JSON.stringify({ ok: true, skipped: false, assertions })}`)
} finally {
  try {
    if (server) await bounded(server.dispose(), 10_000, "worker shutdown deadline")
  } finally {
    const target = resolve(root)
    const within = relative(resolve(tmpdir()), target)
    if (!within || within.startsWith("..") || isAbsolute(within))
      throw new Error("worker cleanup escaped temporary root")
    await rm(target, { recursive: true, force: true })
  }
}

function ok(value: boolean, message: string) {
  assertions++
  assert.ok(value, message)
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
