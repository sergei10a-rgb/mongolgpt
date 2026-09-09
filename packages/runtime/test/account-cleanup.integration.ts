import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"

type Native = typeof import("./fixtures/backup-writes-native.ts")
const native = (await import(pathToFileURL(process.argv[2]).href)) as Native
const root = await mkdtemp(join(tmpdir(), "mongolgpt-account-cleanup-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>>> | undefined
let assertions = 0
const accountID = "acc_cleanup"
const request = { accountID, requestID: "del_cleanup", workspaceIDs: ["wrk_console", "wrk_console"] }

try {
  platform = await getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>({
    configPath: fileURLToPath(new URL("./fixtures/history-d1.jsonc", import.meta.url)),
    persist: { path: root },
    remoteBindings: false,
    envFiles: [],
  })
  const db = platform.env.DB
  const bucket = platform.env.BACKUPS
  for (const name of [
    "0001_history.sql",
    "0002_history_checkpoint.sql",
    "0003_file_revision.sql",
    "0004_account_retirement.sql",
    "0005_backup_write_fences.sql",
    "0006_account_cleanup.sql",
  ]) {
    const sql = await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8")
    for (const statement of unstable_splitSqlQuery(sql)) await db.prepare(statement).run()
  }
  const history = native.createHistoryStore(db)
  const scopes = ["wrk_history", "wrk_registered", "wrk_backup"]
  const owner = { accountID, workspaceID: scopes[0] }
  await history.claim(owner, { expectedEpoch: 0, writerID: "writer_cleanup" })
  await db.batch([
    db
      .prepare(
        "INSERT INTO runtime_history_session (account_id, workspace_id, session_id) VALUES (?, ?, 'ses_cleanup')",
      )
      .bind(accountID, owner.workspaceID),
    db
      .prepare(
        "INSERT INTO runtime_history_checkpoint (account_id,workspace_id,checkpoint_id,epoch,writer_id,digest,data) VALUES (?,?,'cp_cleanup',1,'writer_cleanup','digest','{}')",
      )
      .bind(accountID, owner.workspaceID),
    db
      .prepare(
        "INSERT INTO runtime_file_revision (account_id,workspace_id,revision_id,checkpoint_id,sequence,epoch,writer_id,digest,data) VALUES (?,?,'rev_cleanup','cp_cleanup',1,1,'writer_cleanup','digest','{}')",
      )
      .bind(accountID, owner.workspaceID),
    db
      .prepare(
        "INSERT INTO runtime_history_checkpoint_event (account_id,workspace_id,event_id,aggregate_id,seq) VALUES (?,?,'evt_checkpoint','ses_cleanup',0)",
      )
      .bind(accountID, owner.workspaceID),
    db
      .prepare(
        `INSERT INTO runtime_history_event (account_id,workspace_id,session_id,event_id,seq,type,data,digest)
      SELECT ?, ?, 'ses_cleanup', 'event_' || value, value, 'message', 'private chat body', 'digest' FROM json_each(?)`,
      )
      .bind(accountID, owner.workspaceID, JSON.stringify(Array.from({ length: 501 }, (_, i) => i))),
  ])
  const objectID = "a".repeat(64)
  const registeredScope = { accountID, workspaceID: scopes[1] }
  await native.registerRuntimeSandbox(db, registeredScope, objectID)
  await native.registerRuntimeSandbox(db, registeredScope, objectID)
  equal(
    (await db.prepare("SELECT * FROM runtime_sandbox").all()).results.length,
    1,
    "registration retry duplicated scope",
  )
  await rejected(native.registerRuntimeSandbox(db, { ...registeredScope, accountID: "acc_other" }, objectID))
  const archive = new Uint8Array([1, 2, 3])
  const settledKey = key(accountID, scopes[2], 1)
  await native
    .createRetirableBackupBucket(db, bucket, { accountID, workspaceID: scopes[2] })
    .put(settledKey, archive, { onlyIf: { etagDoesNotMatch: "*" } })
  const unknownKey = key(accountID, scopes[2], 2)
  await rejected(
    native
      .createRetirableBackupBucket(
        db,
        {
          get: bucket.get.bind(bucket),
          put: (async (...args) => {
            await bucket.put(...args)
            throw new Error("private lost R2 acknowledgement")
          }) as R2Bucket["put"],
        },
        { accountID, workspaceID: scopes[2] },
      )
      .put(unknownKey, archive, { onlyIf: { etagDoesNotMatch: "*" } }),
  )
  const neighbor = { accountID: `${accountID}2`, workspaceID: owner.workspaceID }
  await history.claim(neighbor, { expectedEpoch: 0, writerID: "other_writer" })
  await native
    .createRetirableBackupBucket(db, bucket, neighbor)
    .put(key(neighbor.accountID, neighbor.workspaceID, 1), archive, { onlyIf: { etagDoesNotMatch: "*" } })

  const stopped: string[] = []
  let lostStop = true
  const stop: Parameters<typeof native.runRuntimeAccountCleanupPage>[1]["stop"] = async (scope) => {
    equal(scope.accountID, accountID, "wrong account stopped")
    equal(scope.requestID, request.requestID, "wrong request stop receipt")
    equal(
      await db
        .prepare("SELECT account_id FROM runtime_history_retirement WHERE account_id = ?")
        .bind(accountID)
        .first<string>("account_id"),
      accountID,
      "sandbox stopped before durable account fence",
    )
    stopped.push(scope.workspaceID)
    if (scope.workspaceID === "wrk_history" && lostStop) {
      lostStop = false
      throw new Error("private lost stop acknowledgement")
    }
    return { ...scope, stopped: true }
  }
  const page = () => native.runRuntimeAccountCleanupPage(request, { db, bucket, stop })
  equal((await page()).complete, false, "prepare claimed completion")
  equal(
    (await db.prepare("SELECT workspace_id FROM runtime_account_cleanup_workspace ORDER BY workspace_id").all())
      .results,
    ["wrk_backup", "wrk_console", "wrk_history", "wrk_registered"].map((workspace_id) => ({ workspace_id })),
    "inventory missed a scope source",
  )
  await rejected(native.registerRuntimeSandbox(db, registeredScope, "b".repeat(64)))
  await rejected(native.runRuntimeAccountCleanupPage({ ...request, requestID: "del_wrong" }, { db, bucket, stop }))
  await rejected(native.runRuntimeAccountCleanupPage({ ...request, workspaceIDs: ["wrk_wrong"] }, { db, bucket, stop }))
  await rejected(
    native.runRuntimeAccountCleanupPage(request, {
      db,
      bucket,
      stop: async (scope) => ({ ...scope, accountID: "wrong", stopped: true }),
    }),
  )
  equal(
    await db
      .prepare("SELECT phase FROM runtime_account_cleanup WHERE account_id = ?")
      .bind(accountID)
      .first<number>("phase"),
    1,
    "bad stop receipt advanced phase",
  )
  equal((await bucket.head(settledKey))?.size, 3, "data erased before sandbox termination")
  await rejected(page())
  equal(
    (
      await db
        .prepare("SELECT workspace_id FROM runtime_account_cleanup_workspace WHERE stopped = 1 ORDER BY workspace_id")
        .all()
    ).results,
    [{ workspace_id: "wrk_backup" }, { workspace_id: "wrk_console" }],
    "stop progress was not persisted before interruption",
  )
  equal((await bucket.head(settledKey))?.size, 3, "failed stop erased backup content")
  await page()
  equal(
    stopped,
    ["wrk_backup", "wrk_console", "wrk_history", "wrk_history", "wrk_registered"],
    "stop retry skipped or repeated acknowledged scopes",
  )
  const lostProgress = {
    batch: db.batch.bind(db),
    prepare(query: string) {
      const prepared = db.prepare(query)
      if (!query.startsWith("UPDATE runtime_account_cleanup SET phase")) return prepared
      return {
        bind(...values: unknown[]) {
          return {
            run: async () => {
              await prepared.bind(...values).run()
              throw new Error("private lost D1 progress acknowledgement")
            },
          }
        },
      } as unknown as D1PreparedStatement
    },
  }
  await rejected(native.runRuntimeAccountCleanupPage(request, { db: lostProgress, bucket, stop }))
  equal(
    await db
      .prepare("SELECT phase FROM runtime_account_cleanup WHERE account_id = ?")
      .bind(accountID)
      .first<number>("phase"),
    3,
    "committed progress was lost with its acknowledgement",
  )
  equal(await bucket.head(settledKey), null, "settled content remains")
  equal((await bucket.head(unknownKey))?.size, 0, "uncertain backup not fenced")
  await page()
  const deleting = await page()
  equal(deleting.complete, false, "first content page claimed completion")
  equal(
    await db
      .prepare("SELECT count(*) AS n FROM runtime_history_event WHERE account_id = ?")
      .bind(accountID)
      .first<number>("n"),
    1,
    "D1 deletion was not bounded at 500 rows",
  )
  let result = deleting
  for (let i = 0; i < 15 && !result.complete; i++) result = await page()
  equal(result, { requestID: request.requestID, accountID, complete: true }, "cleanup never reached durable completion")
  equal(await page(), result, "completion receipt not idempotent")
  equal(stopped.length, 5, "resumption repeated acknowledged stops")
  for (const table of [
    "runtime_history_writer",
    "runtime_history_session",
    "runtime_history_event",
    "runtime_history_checkpoint",
    "runtime_history_checkpoint_event",
    "runtime_file_revision",
  ]) {
    equal(
      await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id = ?`).bind(accountID).first<number>("n"),
      0,
      `${table} retained content`,
    )
  }
  equal(
    (await bucket.list({ prefix: `runtime-backups/v1/${accountID}/` })).objects.map((o) => o.key),
    [unknownKey],
    "unexpected content after cleanup",
  )
  equal(await (await bucket.get(unknownKey))?.text(), "", "retained fence contains content")
  equal(
    await bucket.put(unknownKey, archive, { onlyIf: { etagDoesNotMatch: "*" } }),
    null,
    "old upload resurrected content",
  )
  await rejected(history.claim(owner, { expectedEpoch: 1, writerID: "new_writer" }))
  equal(
    (await history.claim(neighbor, { expectedEpoch: 1, writerID: "other_writer_2" })).accountID,
    neighbor.accountID,
    "neighbor history damaged",
  )
  equal((await bucket.head(key(neighbor.accountID, neighbor.workspaceID, 1)))?.size, 3, "neighbor backup removed")
  await rejected(
    db.prepare("UPDATE runtime_account_cleanup SET phase = 0 WHERE account_id = ?").bind(accountID).run(),
    false,
  )
  await rejected(db.prepare("DELETE FROM runtime_sandbox WHERE account_id = ?").bind(accountID).run(), false)

  console.log("ACCOUNT_CLEANUP_PHASE legacy_fail_closed")
  const legacy = { accountID: "acc_legacy", requestID: "del_legacy", workspaceIDs: ["wrk_legacy"] }
  const legacyKey = key(legacy.accountID, legacy.workspaceIDs[0], 1)
  await bucket.put(legacyKey, archive)
  const legacyPage = () =>
    native.runRuntimeAccountCleanupPage(legacy, { db, bucket, stop: async (scope) => ({ ...scope, stopped: true }) })
  await legacyPage()
  await legacyPage()
  await legacyPage()
  await rejected(legacyPage())
  equal(
    await db
      .prepare("SELECT phase FROM runtime_account_cleanup WHERE account_id = ?")
      .bind(legacy.accountID)
      .first<number>("phase"),
    3,
    "untracked backup produced a complete receipt",
  )
  equal((await bucket.head(legacyKey))?.size, 3, "legacy data silently discarded without write inventory")

  console.log("ACCOUNT_CLEANUP_PHASE bounded_concurrent_pages")
  const many = {
    accountID: "acc_many",
    requestID: "del_many",
    workspaceIDs: Array.from({ length: 25 }, (_, i) => `wrk_many${i}`),
  }
  const seen = new Set<string>()
  const manyPage = () =>
    native.runRuntimeAccountCleanupPage(many, {
      db,
      bucket,
      stop: async (scope) => {
        seen.add(scope.workspaceID)
        return { ...scope, stopped: true }
      },
    })
  await manyPage()
  await manyPage()
  equal(seen.size, 20, "sandbox stop page was not bounded")
  await manyPage()
  equal(seen.size, 25, "remaining sandbox page was skipped")
  for (let i = 0; i < 12; i++) await Promise.all([manyPage(), manyPage()])
  equal(
    await manyPage(),
    { accountID: many.accountID, requestID: many.requestID, complete: true },
    "concurrent retries could not finish",
  )
  equal(
    await db
      .prepare("SELECT count(*) AS n FROM runtime_account_cleanup_workspace WHERE account_id = ? AND stopped = 0")
      .bind(many.accountID)
      .first<number>("n"),
    0,
    "concurrent cleanup skipped a sandbox",
  )

  console.log(
    `ACCOUNT_CLEANUP_RESULT ${JSON.stringify({ ok: true, assertions, realD1: true, realR2: true, simulatedStop: true })}`,
  )
} finally {
  try {
    await platform?.dispose()
  } finally {
    const inside = relative(resolve(tmpdir()), resolve(root))
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("account cleanup escaped temp root")
    await rm(root, { recursive: true, force: true })
  }
}

function key(accountID: string, workspaceID: string, index: number) {
  return `runtime-backups/v1/${accountID}/${workspaceID}/00000000-0000-4000-8000-${String(index).padStart(12, "0")}/000000.bin`
}
function equal(actual: unknown, expected: unknown, message: string) {
  assertions++
  assert.deepEqual(actual, expected, message)
}
async function rejected(work: Promise<unknown>, sanitized = true) {
  assertions++
  await assert.rejects(
    work,
    (e: unknown) => e instanceof Error && (!sanitized || !/private|SELECT|INSERT|UPDATE/.test(e.message)),
  )
}
