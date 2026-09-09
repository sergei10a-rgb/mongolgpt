import { eraseRetiredBackupWritePage } from "./backup-writes"
import type { HistoryScope } from "./history"
import { validateSandboxRetirement, type SandboxRetirement } from "./sandbox-retirement"

type Database = Pick<D1Database, "prepare" | "batch">
type Bucket = Pick<R2Bucket, "put" | "delete" | "head" | "list">
type Cleanup = { accountID: string; requestID: string; workspaceIDs: string[] }
type Job = { account_id: string; request_id: string; workspace_ids: string; phase: number; cursor: string }

export class RuntimeCleanupError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "unavailable" | "untracked_backup") {
    super(code)
    this.name = "RuntimeCleanupError"
  }
}

// Called before touching a DO. Keep the exact namespace ID across secret rotation.
export async function registerRuntimeSandbox(db: Pick<D1Database, "prepare">, tenant: HistoryScope, objectID: string) {
  const scope = { accountID: tenant.accountID, workspaceID: tenant.workspaceID }
  validateSandboxRetirement({ ...scope, requestID: "registration" })
  if (!/^[0-9a-f]{64}$/.test(objectID)) throw new RuntimeCleanupError("invalid")
  try {
    const saved = await db
      .prepare(
        `INSERT INTO runtime_sandbox (object_id, account_id, workspace_id)
      SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = ?)
      ON CONFLICT(object_id) DO NOTHING`,
      )
      .bind(objectID, scope.accountID, scope.workspaceID, scope.accountID)
      .run()
    if (!saved.success) throw new RuntimeCleanupError("unavailable")
    const row = await db
      .prepare(
        `SELECT account_id, workspace_id FROM runtime_sandbox
      WHERE object_id = ? AND NOT EXISTS (SELECT 1 FROM runtime_history_retirement WHERE account_id = ?)`,
      )
      .bind(objectID, scope.accountID)
      .first<{ account_id: string; workspace_id: string }>()
    if (row?.account_id !== scope.accountID || row.workspace_id !== scope.workspaceID)
      throw new RuntimeCleanupError("unavailable")
  } catch {
    throw new RuntimeCleanupError("unavailable")
  }
}

// One bounded, resumable page. Only the final phase is a whole-runtime receipt.
// Unregistered legacy uploads block completion: listing cannot prove an unknown
// old in-flight writer will not create another key after the list finishes.
export async function runRuntimeAccountCleanupPage(
  value: Cleanup,
  dependencies: {
    db: Database
    bucket: Bucket
    stop: (scope: SandboxRetirement) => Promise<SandboxRetirement & { stopped: true }>
  },
) {
  const input = validate(value)
  const db = dependencies.db
  const accountID = input.accountID
  const workspaces = JSON.stringify(input.workspaceIDs)
  try {
    const reserved = await db
      .prepare(
        `INSERT INTO runtime_account_cleanup (account_id, request_id, workspace_ids)
      VALUES (?, ?, ?) ON CONFLICT(account_id) DO NOTHING`,
      )
      .bind(accountID, input.requestID, workspaces)
      .run()
    if (!reserved.success) throw new RuntimeCleanupError("unavailable")
    const job = await db
      .prepare("SELECT * FROM runtime_account_cleanup WHERE account_id = ?")
      .bind(accountID)
      .first<Job>()
    if (!job || job.request_id !== input.requestID || job.workspace_ids !== workspaces)
      throw new RuntimeCleanupError("conflict")
    if (!Number.isInteger(job.phase) || job.phase < 0 || job.phase > 5 || typeof job.cursor !== "string")
      throw new RuntimeCleanupError("unavailable")
    if (job.phase === 5) return { requestID: input.requestID, accountID, complete: true as const }
    if (job.phase === 0) {
      const results = await db.batch([
        db
          .prepare("INSERT INTO runtime_history_retirement (account_id) VALUES (?) ON CONFLICT(account_id) DO NOTHING")
          .bind(accountID),
        db
          .prepare(
            `INSERT INTO runtime_account_cleanup_workspace (account_id, workspace_id)
          SELECT ?, workspace_id FROM (
            SELECT value AS workspace_id FROM json_each(?)
            UNION SELECT workspace_id FROM runtime_history_writer WHERE account_id = ?
            UNION SELECT workspace_id FROM runtime_backup_write WHERE account_id = ?
            UNION SELECT workspace_id FROM runtime_sandbox WHERE account_id = ?
          ) WHERE EXISTS (SELECT 1 FROM runtime_account_cleanup WHERE account_id = ? AND phase = 0)
          ON CONFLICT(account_id, workspace_id) DO NOTHING`,
          )
          .bind(accountID, workspaces, accountID, accountID, accountID, accountID),
        advance(db, job, 1),
      ])
      if (results.some((result) => !result.success)) throw new RuntimeCleanupError("unavailable")
      return pending(input)
    }
    if (
      !(await db
        .prepare("SELECT account_id FROM runtime_history_retirement WHERE account_id = ?")
        .bind(accountID)
        .first())
    )
      throw new RuntimeCleanupError("unavailable")
    if (job.phase === 1) {
      const scopes = await db
        .prepare(
          `SELECT workspace_id FROM runtime_account_cleanup_workspace
        WHERE account_id = ? AND stopped = 0 ORDER BY workspace_id LIMIT 20`,
        )
        .bind(accountID)
        .all<{ workspace_id: string }>()
      if (!scopes.success) throw new RuntimeCleanupError("unavailable")
      for (const row of scopes.results) {
        const scope = validateSandboxRetirement({
          accountID,
          workspaceID: row.workspace_id,
          requestID: input.requestID,
        })
        const result = await dependencies.stop(scope)
        if (
          result?.stopped !== true ||
          result.accountID !== accountID ||
          result.workspaceID !== row.workspace_id ||
          result.requestID !== input.requestID
        )
          throw new RuntimeCleanupError("unavailable")
        const changed = await db
          .prepare(`UPDATE runtime_account_cleanup_workspace SET stopped = 1 WHERE account_id = ? AND workspace_id = ?`)
          .bind(accountID, row.workspace_id)
          .run()
        if (!changed.success) throw new RuntimeCleanupError("unavailable")
      }
      if (scopes.results.length < 20) await advance(db, job, 2).run()
      return pending(input)
    }
    if (job.phase === 2) {
      const page = await eraseRetiredBackupWritePage(db, dependencies.bucket, {
        accountID,
        ...(job.cursor ? { after: job.cursor } : {}),
      })
      await advance(db, job, page.next === null ? 3 : 2, page.next ?? "").run()
      return pending(input)
    }
    if (job.phase === 3) {
      const prefix = `runtime-backups/v1/${accountID}/`
      const page = await dependencies.bucket.list({ prefix, limit: 100, ...(job.cursor ? { cursor: job.cursor } : {}) })
      for (const object of page.objects) {
        if (!object.key.startsWith(prefix)) throw new RuntimeCleanupError("unavailable")
        const registered = await db
          .prepare("SELECT settled FROM runtime_backup_write WHERE account_id = ? AND object_key = ?")
          .bind(accountID, object.key)
          .first<{ settled: number }>()
        if (!registered) throw new RuntimeCleanupError("untracked_backup")
        if (registered.settled === 1) {
          await dependencies.bucket.delete(object.key)
          const remaining = await dependencies.bucket.head(object.key)
          if (remaining && !fence(remaining)) throw new RuntimeCleanupError("unavailable")
        } else {
          const remaining = await dependencies.bucket.head(object.key)
          if (registered.settled !== 0 || !remaining || !fence(remaining)) throw new RuntimeCleanupError("unavailable")
        }
      }
      if (page.truncated && (!page.cursor || page.cursor === job.cursor)) throw new RuntimeCleanupError("unavailable")
      await advance(db, job, page.truncated ? 3 : 4, page.truncated ? page.cursor : "").run()
      return pending(input)
    }
    // Children first, bounded pages, including legacy orphan rows. Never rely
    // on one unbounded parent cascade to remove an account's entire history.
    const tables = [
      "runtime_history_event",
      "runtime_history_session",
      "runtime_history_checkpoint_event",
      "runtime_file_revision",
      "runtime_history_checkpoint",
      "runtime_history_writer",
      "runtime_backup_write",
    ] as const
    if (job.cursor && !/^[1-6]$/.test(job.cursor)) throw new RuntimeCleanupError("unavailable")
    const index = Number(job.cursor || "0")
    const table = tables[index]
    const settled = table === "runtime_backup_write" ? " AND settled = 1" : ""
    const result = await db
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (
      SELECT rowid FROM ${table} WHERE account_id = ?${settled} LIMIT 500
    )`,
      )
      .bind(accountID)
      .run()
    if (!result.success) throw new RuntimeCleanupError("unavailable")
    const remaining = await db
      .prepare(`SELECT 1 FROM ${table} WHERE account_id = ?${settled} LIMIT 1`)
      .bind(accountID)
      .first()
    if (!remaining)
      await advance(
        db,
        job,
        index === tables.length - 1 ? 5 : 4,
        index === tables.length - 1 ? "" : String(index + 1),
      ).run()
    return pending(input)
  } catch (error) {
    if (error instanceof RuntimeCleanupError) throw error
    throw new RuntimeCleanupError("unavailable")
  }
}

function advance(db: Database, job: Job, phase: number, cursor = "") {
  return db
    .prepare(
      `UPDATE runtime_account_cleanup SET phase = ?, cursor = ?
    WHERE account_id = ? AND request_id = ? AND phase = ? AND cursor = ?`,
    )
    .bind(phase, cursor, job.account_id, job.request_id, job.phase, job.cursor)
}

function pending(input: Cleanup) {
  return { requestID: input.requestID, accountID: input.accountID, complete: false as const }
}

function fence(object: R2Object) {
  return (
    object.size === 0 &&
    Object.keys(object.customMetadata ?? {}).length === 1 &&
    object.customMetadata?.["mongolgpt-retired-write"] === "v1"
  )
}

function validate(value: Cleanup): Cleanup {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "accountID,requestID,workspaceIDs" ||
    !Array.isArray(value.workspaceIDs) ||
    value.workspaceIDs.length > 1000
  )
    throw new RuntimeCleanupError("invalid")
  try {
    validateSandboxRetirement({ accountID: value.accountID, requestID: value.requestID, workspaceID: "validation" })
    for (const workspaceID of value.workspaceIDs)
      validateSandboxRetirement({ accountID: value.accountID, requestID: value.requestID, workspaceID })
  } catch {
    throw new RuntimeCleanupError("invalid")
  }
  return {
    accountID: value.accountID,
    requestID: value.requestID,
    workspaceIDs: [...new Set(value.workspaceIDs)].sort(),
  }
}
