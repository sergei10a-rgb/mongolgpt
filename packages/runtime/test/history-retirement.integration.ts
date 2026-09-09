import assert from "node:assert/strict"
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import type { createHistoryStore } from "../src/history.ts"
import type { createCheckpointHandler } from "../src/checkpoint-rpc.ts"

export async function runRetirementChecks(
  db: D1Database,
  bucket: R2Bucket,
  native: { createHistoryStore: typeof createHistoryStore; createCheckpointHandler: typeof createCheckpointHandler },
  checkpoint: CloudCheckpoint.Checkpoint,
) {
  let assertions = 0
  const history = native.createHistoryStore(db)
  const scope = { accountID: "acc_retirement", workspaceID: "wrk_shared" }
  const other = { accountID: "acc_retirement_other", workspaceID: scope.workspaceID }
  const second = { ...scope, workspaceID: "wrk_second" }
  const newScope = { ...scope, workspaceID: "wrk_never_created" }
  const lease = await history.claim(scope, { expectedEpoch: 0, writerID: "writer_retirement" })
  const secondLease = await history.claim(second, { expectedEpoch: 0, writerID: "writer_second" })
  const otherLease = await history.claim(other, { expectedEpoch: 0, writerID: "writer_other" })
  const baseline = { ...checkpoint, id: crypto.randomUUID() }
  await history.publishCheckpoint(lease, baseline)
  const revision: CloudCheckpoint.FileRevision = {
    id: crypto.randomUUID(),
    checkpointID: baseline.id,
    sequence: 1,
    previousID: null,
    archive: baseline.files,
  }
  await history.publishFiles(lease, revision)
  const event = {
    id: "evt_retirement",
    aggregateID: "ses_retirement",
    seq: 0,
    type: "session.created.1",
    data: { private: "retained until cleanup" },
  }
  await history.append(lease, event)
  await history.append(secondLease, event)
  await history.append(otherLease, event)
  const counts = async () =>
    db
      .prepare("SELECT COUNT(*) AS count FROM runtime_history_event WHERE account_id = ?")
      .bind(scope.accountID)
      .first("count")
  const before = await counts()
  await history.retire(scope.accountID)
  await history.retire(scope.accountID)
  equal(await counts(), before, "retirement must not claim to erase retained content")
  equal(
    (await db.prepare("SELECT * FROM runtime_history_retirement WHERE account_id = ?").bind(scope.accountID).all())
      .results.length,
    1,
    "retirement retry duplicated its marker",
  )

  for (const tenant of [scope, second, newScope]) {
    await fenced(history.assertActive(tenant))
    await fenced(history.epoch(tenant))
    await fenced(history.read(tenant, { checkpointID: baseline.id }))
    await fenced(history.checkpoint(tenant))
    await fenced(history.fileRevision(tenant))
    await fenced(history.claim(tenant, { expectedEpoch: 0, writerID: "late_writer" }))
  }
  await fenced(
    history.claim(scope, {
      expectedEpoch: 1,
      writerID: "late_writer",
      checkpointID: baseline.id,
      filesRevisionID: revision.id,
    }),
  )
  await fenced(history.append(lease, event))
  await fenced(history.append(secondLease, { ...event, id: "evt_late", seq: 1 }))
  await fenced(history.erase(lease, { id: "evt_late_erase", aggregateID: event.aggregateID, seq: 1 }))
  await fenced(history.publishCheckpoint(lease, baseline))
  await fenced(history.publishFiles(lease, revision))
  await fenced(
    history.publishFiles(lease, { ...revision, id: crypto.randomUUID(), previousID: revision.id, sequence: 2 }),
  )

  // Raw SQL represents an older writer without the application-level gate.
  for (const table of [
    "runtime_history_writer",
    "runtime_history_session",
    "runtime_history_event",
    "runtime_history_checkpoint",
    "runtime_history_checkpoint_event",
    "runtime_file_revision",
  ]) {
    const columns = (await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map(
      (row) => row.name,
    )
    await rejected(
      db
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${table} WHERE account_id = ?`,
        )
        .bind(scope.accountID)
        .run(),
    )
    await rejected(
      db.prepare(`UPDATE ${table} SET account_id = account_id WHERE account_id = ?`).bind(scope.accountID).run(),
    )
  }
  await rejected(
    db
      .prepare("INSERT INTO runtime_history_writer VALUES (?, ?, 1, 'late')")
      .bind(scope.accountID, newScope.workspaceID)
      .run(),
  )
  await rejected(
    db
      .prepare("UPDATE runtime_history_writer SET account_id = ? WHERE account_id = ?")
      .bind("acc_escape", scope.accountID)
      .run(),
  )
  await rejected(db.prepare("DELETE FROM runtime_history_retirement WHERE account_id = ?").bind(scope.accountID).run())
  await rejected(
    db
      .prepare("UPDATE runtime_history_retirement SET account_id = 'acc_escape' WHERE account_id = ?")
      .bind(scope.accountID)
      .run(),
  )
  equal(await counts(), before, "rejected late mutations changed retained history")

  await rejected(
    db.batch([
      db.prepare("INSERT INTO runtime_history_writer VALUES ('acc_batch_rollback', 'wrk', 1, 'writer')"),
      db.prepare("INSERT INTO runtime_history_writer VALUES (?, 'wrk_late', 1, 'late')").bind(scope.accountID),
    ]),
  )
  equal(
    await history.epoch({ accountID: "acc_batch_rollback", workspaceID: "wrk" }),
    0,
    "retired write did not roll back the whole D1 batch",
  )

  const handler = native.createCheckpointHandler({ history }, scope)
  for (const route of ["bootstrap", "begin", "archive", "publish", "publish-files", "upload"]) {
    const response = await handler(
      new Request(`http://checkpoint.mongolgpt.internal/v1/${route}`, {
        method: "POST",
        headers: { "content-type": route === "upload" ? "application/octet-stream" : "application/json" },
        body: route === "upload" ? "not read or stored" : "{}",
      }),
    )
    equal(response.status, 409, `retired checkpoint ${route} was admitted`)
    equal(response.headers.get("cache-control"), "no-store", "retired response allowed caching")
    equal(
      /keyID|backupID|retained until cleanup|SQL/.test(await response.text()),
      false,
      "retired response exposed retained data",
    )
  }
  equal(
    (await bucket.list({ prefix: `runtime-backups/v1/${scope.accountID}/` })).objects.length,
    0,
    "retired upload created R2 content",
  )
  await history.append(otherLease, { ...event, id: "evt_other_after_retirement", seq: 1 })
  equal((await history.read(other)).entries.length, 2, "retiring one account affected another in the same workspace")
  await history.retire("acc_retired_empty")
  await fenced(
    history.claim({ accountID: "acc_retired_empty", workspaceID: "wrk_new" }, { expectedEpoch: 0, writerID: "late" }),
  )

  // Lose only the acknowledgement after the real D1 commit, then retry normally.
  const lost = native.createHistoryStore({
    prepare(query: string) {
      return {
        bind: (...values: string[]) => ({
          run: async () => {
            await db
              .prepare(query)
              .bind(...values)
              .run()
            throw new Error("lost retirement acknowledgement")
          },
        }),
      }
    },
  } as unknown as Parameters<typeof native.createHistoryStore>[0])
  assertions++
  await assert.rejects(
    lost.retire("acc_retirement_lost"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "unavailable",
  )
  await history.retire("acc_retirement_lost")
  await fenced(history.assertActive({ accountID: "acc_retirement_lost", workspaceID: "wrk_new" }))

  return {
    assertions,
    async afterRestart(database: D1Database) {
      const start = assertions
      const reopened = native.createHistoryStore(database)
      for (const tenant of [scope, second, newScope]) await fenced(reopened.assertActive(tenant))
      await reopened.retire(scope.accountID)
      await fenced(reopened.claim(newScope, { expectedEpoch: 0, writerID: "late_restart" }))
      equal((await reopened.read(other)).entries.length, 2, "restart changed the other account")
      return assertions - start
    },
  }

  function equal(actual: unknown, expected: unknown, message: string) {
    assertions++
    assert.equal(actual, expected, message)
  }
  async function fenced(operation: Promise<unknown>) {
    assertions++
    await assert.rejects(
      operation,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "fenced",
    )
  }
  async function rejected(operation: Promise<unknown>) {
    assertions++
    await assert.rejects(operation, /runtime_account_retir/)
  }
}
