import { matchesControlToken } from "@mongolgpt/runtime-auth/control"
import { blockedEgressHosts, MongolGPTSandbox } from "../../src/index"
import { createHistoryStore } from "../../src/history"

export { ContainerProxy } from "../../src/index"

type Environment = {
  HISTORY: D1Database
  RUNTIME_BACKUPS: R2Bucket
  MONGOLGPT_RUNTIME_SECRET: string
  MONGOLGPT_RUNTIME_BACKUP_KEYS: string
  BRIDGE_ADMIN_TOKEN: string
  BRIDGE_SCOPE: { accountID: string; workspaceID: string }
  BRIDGE_MIGRATIONS: Array<{ name: string; statements: string[] }>
}

const checkpointHost = "checkpoint.mongolgpt.internal"
const historyHost = "history.mongolgpt.internal"
const checkpointPaths = new Set([
  "/v1/bootstrap",
  "/v1/begin",
  "/v1/upload",
  "/v1/archive",
  "/v1/publish",
  "/v1/publish-files",
])
const historyPaths = new Set(["/v1/epoch", "/v1/claim", "/v1/append", "/v1/erase", "/v1/read"])
const ledger = "container_checkpoint_bridge_migration"

// Loopback-only fixture. Configuration and all credentials live in the private namespace.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !matchesControlToken(request.headers.get("x-test-admin-token"), env.BRIDGE_ADMIN_TOKEN) ||
      env.BRIDGE_SCOPE.accountID !== "account_container_integration" ||
      env.BRIDGE_SCOPE.workspaceID !== "workspace_container_integration"
    )
      return Response.json({ error: { code: "forbidden" } }, { status: 403 })
    if (url.search || url.hash) return new Response(null, { status: 400 })
    let phase = "dispatch"
    try {
      if (request.method === "POST" && url.pathname === "/__test/setup") {
        phase = "migration_table"
        await env.HISTORY.prepare(
          `CREATE TABLE IF NOT EXISTS ${ledger} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
        ).run()
        for (const migration of env.BRIDGE_MIGRATIONS) {
          phase = "migration_query"
          if (await env.HISTORY.prepare(`SELECT name FROM ${ledger} WHERE name = ?`).bind(migration.name).first())
            continue
          const statements = migration.statements.map((statement) => env.HISTORY.prepare(statement))
          statements.push(
            env.HISTORY.prepare(`INSERT INTO ${ledger} (name, applied_at) VALUES (?, ?)`).bind(
              migration.name,
              Date.now(),
            ),
          )
          phase = "migration_batch"
          const results = await env.HISTORY.batch(statements)
          if (results.some((result) => !result.success)) throw new Error("bridge migration failed")
        }
        return Response.json({ ready: true })
      }
      if (request.method === "GET" && url.pathname === "/__test/status") {
        const store = createHistoryStore(env.HISTORY)
        return Response.json({
          epoch: await store.epoch(env.BRIDGE_SCOPE),
          checkpoint: (await store.checkpoint(env.BRIDGE_SCOPE)) ?? null,
          revision: (await store.fileRevision(env.BRIDGE_SCOPE)) ?? null,
        })
      }
      const host = request.headers.get("x-test-outbound-host")
      if (
        request.method !== "POST" ||
        !(
          (host === checkpointHost && checkpointPaths.has(url.pathname)) ||
          (host === historyHost && historyPaths.has(url.pathname))
        )
      )
        return new Response(null, { status: 404 })
      const forwarded = new Request(`http://${host}${url.pathname}`, request)
      forwarded.headers.delete("x-test-admin-token")
      forwarded.headers.delete("x-test-outbound-host")
      // The pinned Workers types predate ctx.exports; this is the real workerd entrypoint binding.
      const entrypoints = (
        ctx as ExecutionContext & {
          exports: { ContainerProxy(options: { props: Record<string, unknown> }): Fetcher }
        }
      ).exports
      const proxy = entrypoints.ContainerProxy({
        props: {
          className: MongolGPTSandbox.name,
          containerId: "container-checkpoint-loopback",
          outboundByHostOverrides: {
            [checkpointHost]: { method: "checkpoint", params: env.BRIDGE_SCOPE },
            [historyHost]: { method: "history", params: env.BRIDGE_SCOPE },
          },
          enableInternet: false,
          allowedHosts: ["*"],
          deniedHosts: blockedEgressHosts,
          interceptAll: true,
        },
      })
      const response = await proxy.fetch(forwarded)
      const headers = new Headers(response.headers)
      headers.set("x-test-bridge-workerd", "container-proxy")
      return new Response(response.body, { status: response.status, headers })
    } catch (error) {
      const type =
        error instanceof Error && ["Error", "TypeError", "RangeError"].includes(error.name) ? error.name : "unknown"
      return Response.json(
        { error: { code: "unavailable" } },
        {
          status: 503,
          headers: { "x-test-worker-phase": phase, "x-test-worker-error-type": type },
        },
      )
    }
  },
} satisfies ExportedHandler<Environment>
