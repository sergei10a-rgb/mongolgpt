import { RuntimeBackupError } from "./backup"
import type { HistoryScope } from "./history"

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const objectSuffix =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:[0-9]{6}\.bin|manifest\.json)$/
const pageSize = 100
const fenceMetadata = { "mongolgpt-retired-write": "v1" }
type WriteRow = { object_key: string; workspace_id: string; settled: number }
type Database = Pick<D1Database, "prepare">

// This adapter is only for backup.ts's immutable, create-only object writes.
// Persist intent BEFORE R2 I/O; ambiguous errors deliberately stay unsettled.
export function createRetirableBackupBucket(db: Database, bucket: Pick<R2Bucket, "get" | "put">, tenant: HistoryScope) {
  const scope = { accountID: tenant.accountID, workspaceID: tenant.workspaceID }
  validateScope(scope)
  const guarded: Pick<R2Bucket, "get" | "put"> = {
    async get(key, options) {
      validateKey(scope, key)
      return bucket.get(key, options)
    },
    async put(key, value, options) {
      validateKey(scope, key)
      if (
        !options?.onlyIf ||
        options.onlyIf instanceof Headers ||
        Object.keys(options.onlyIf).length !== 1 ||
        options.onlyIf.etagDoesNotMatch !== "*"
      )
        throw new RuntimeBackupError("invalid")
      const immutable = { ...options, onlyIf: { etagDoesNotMatch: "*" } }
      try {
        const admitted = await db
          .prepare(
            `INSERT INTO runtime_backup_write (object_key, account_id, workspace_id)
          SELECT ?, ?, ? WHERE NOT EXISTS (
            SELECT 1 FROM runtime_history_retirement WHERE account_id = ?
          )`,
          )
          .bind(key, scope.accountID, scope.workspaceID, scope.accountID)
          .run()
        if (!admitted.success || admitted.meta.changes !== 1) throw new RuntimeBackupError("unavailable")
        const result = await bucket.put(key, value, immutable)
        // A returned object or null is a definitive R2 response. A thrown error
        // is not, even when the caller's connection or request was cancelled.
        const settled = await db
          .prepare(
            `UPDATE runtime_backup_write SET settled = 1
          WHERE object_key = ? AND account_id = ? AND workspace_id = ?`,
          )
          .bind(key, scope.accountID, scope.workspaceID)
          .run()
        if (!settled.success || settled.meta.changes !== 1) throw new RuntimeBackupError("unavailable")
        if (!result) throw new RuntimeBackupError("unavailable")
        return result
      } catch {
        throw new RuntimeBackupError("unavailable")
      }
    },
  }
  return guarded
}

// Worker-internal cleanup page, NOT a complete account-deletion receipt. The
// caller must first stop all sandboxes and also handle history/unregistered data.
// Unsettled keys retain zero-byte control objects: deleting those keys would let
// a delayed If-None-Match:* PUT recreate content after a Worker/DO crash.
export async function eraseRetiredBackupWritePage(
  db: Database,
  bucket: Pick<R2Bucket, "put" | "delete" | "head">,
  input: { accountID: string; after?: string },
) {
  const accountID = input.accountID
  const after = input.after
  if (typeof accountID !== "string" || !identifier.test(accountID)) throw new RuntimeBackupError("invalid")
  if (after !== undefined) {
    if (typeof after !== "string") throw new RuntimeBackupError("invalid")
    validateKey({ accountID, workspaceID: after.split("/")[3] ?? "" }, after)
  }
  try {
    const retired = await db
      .prepare("SELECT account_id FROM runtime_history_retirement WHERE account_id = ?")
      .bind(accountID)
      .first()
    if (!retired) throw new RuntimeBackupError("unavailable")
    const result = await db
      .prepare(
        `SELECT object_key, workspace_id, settled FROM runtime_backup_write
      WHERE account_id = ? AND object_key > ? ORDER BY object_key LIMIT ?`,
      )
      .bind(accountID, after ?? "", pageSize + 1)
      .all<WriteRow>()
    if (!result.success || result.results.length > pageSize + 1) throw new RuntimeBackupError("unavailable")
    for (const row of result.results) {
      validateKey({ accountID, workspaceID: row.workspace_id }, row.object_key)
      if (row.settled !== 0 && row.settled !== 1) throw new RuntimeBackupError("unavailable")
    }
    const rows = result.results.slice(0, pageSize)
    let retainedFences = 0
    for (const row of rows) {
      if (row.settled === 1) {
        await bucket.delete(row.object_key)
        const remaining = await bucket.head(row.object_key)
        // A concurrent older cleanup page may have put a harmless fence here.
        if (remaining && !isFence(remaining)) throw new RuntimeBackupError("unavailable")
      } else {
        const stored = await bucket.put(row.object_key, new Uint8Array(), {
          customMetadata: fenceMetadata,
          httpMetadata: { contentType: "application/octet-stream", cacheControl: "no-store" },
        })
        if (!stored || !isFence(stored)) throw new RuntimeBackupError("unavailable")
        const remaining = await bucket.head(row.object_key)
        if (remaining && !isFence(remaining)) throw new RuntimeBackupError("unavailable")
        retainedFences++
      }
    }
    return {
      processed: rows.length,
      retainedFences,
      next: result.results.length > pageSize ? rows.at(-1)!.object_key : null,
    }
  } catch {
    throw new RuntimeBackupError("unavailable")
  }
}

function isFence(object: R2Object) {
  return (
    object.size === 0 &&
    Object.keys(object.customMetadata ?? {}).length === 1 &&
    object.customMetadata?.["mongolgpt-retired-write"] === "v1"
  )
}

function validateScope(scope: HistoryScope) {
  if (
    typeof scope.accountID !== "string" ||
    typeof scope.workspaceID !== "string" ||
    !identifier.test(scope.accountID) ||
    !identifier.test(scope.workspaceID)
  )
    throw new RuntimeBackupError("invalid")
}

function validateKey(scope: HistoryScope, key: string) {
  validateScope(scope)
  const prefix = `runtime-backups/v1/${scope.accountID}/${scope.workspaceID}/`
  if (typeof key !== "string" || !key.startsWith(prefix) || !objectSuffix.test(key.slice(prefix.length)))
    throw new RuntimeBackupError("invalid")
}
