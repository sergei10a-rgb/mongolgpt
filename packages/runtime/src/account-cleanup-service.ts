import { WorkerEntrypoint } from "cloudflare:workers"
import { runRuntimeAccountCleanupPage, RuntimeCleanupError } from "./account-cleanup"
import { deriveRuntimeIdentity } from "./runtime"
import type { RuntimeEnvironment } from "./index"

// Only the retention Worker receives this named service binding. No HTTP route,
// user capability, sandbox outbound handler, or browser exposes erasure RPC.
export class RuntimeAccountCleanup extends WorkerEntrypoint<RuntimeEnvironment> {
  async ready() {
    try {
      const { db, bucket } = this.#bindings()
      await db
        .prepare(
          `SELECT
        (SELECT object_id FROM runtime_sandbox LIMIT 1),
        (SELECT phase FROM runtime_account_cleanup LIMIT 1),
        (SELECT stopped FROM runtime_account_cleanup_workspace LIMIT 1),
        (SELECT settled FROM runtime_backup_write LIMIT 1),
        (SELECT account_id FROM runtime_history_retirement LIMIT 1)`,
        )
        .first()
      await bucket.list({ prefix: "runtime-backups/v1/", limit: 1 })
      return { ready: true as const, protocol: 1 as const }
    } catch {
      return { ready: false as const, protocol: 1 as const }
    }
  }

  async cleanup(input: Parameters<typeof runRuntimeAccountCleanupPage>[0]) {
    const { db, bucket } = this.#bindings()
    return runRuntimeAccountCleanupPage(input, {
      db,
      bucket,
      stop: async (scope) => {
        const identity = await deriveRuntimeIdentity(
          scope.accountID,
          scope.workspaceID,
          this.env.MONGOLGPT_RUNTIME_SECRET,
        )
        const current = this.env.Sandbox.idFromName(identity.sandboxID).toString()
        const known = await db
          .prepare("SELECT object_id FROM runtime_sandbox WHERE account_id = ? AND workspace_id = ?")
          .bind(scope.accountID, scope.workspaceID)
          .all<{ object_id: string }>()
        if (!known.success) throw new RuntimeCleanupError("unavailable")
        for (const objectID of new Set([current, ...known.results.map((row) => row.object_id)])) {
          const sandbox = this.env.Sandbox.get(this.env.Sandbox.idFromString(objectID))
          const result = await sandbox.retireAccount(scope)
          if (
            result?.stopped !== true ||
            result.accountID !== scope.accountID ||
            result.workspaceID !== scope.workspaceID ||
            result.requestID !== scope.requestID
          )
            throw new RuntimeCleanupError("unavailable")
        }
        return { ...scope, stopped: true as const }
      },
    })
  }

  #bindings() {
    if (
      this.env.MONGOLGPT_RUNTIME_ACCOUNT_CLEANUP !== "true" ||
      !this.env.HISTORY ||
      !this.env.RUNTIME_BACKUPS ||
      !this.env.MONGOLGPT_RUNTIME_SECRET?.trim() ||
      this.env.MONGOLGPT_RUNTIME_SECRET.trim().length < 32
    )
      throw new RuntimeCleanupError("unavailable")
    return { db: this.env.HISTORY, bucket: this.env.RUNTIME_BACKUPS }
  }
}
