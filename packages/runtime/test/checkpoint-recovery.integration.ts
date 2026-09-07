import assert from "node:assert/strict"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"

type FixtureModule = typeof import("./fixtures/history-native.ts")
// Wrangler's Node proxy uses workers-types while the bundle uses Worker globals.
type Native = Omit<FixtureModule, "createRuntimeBackupStore" | "createRuntimeCheckpointStore"> & {
  createRuntimeBackupStore(bucket: R2Bucket): ReturnType<FixtureModule["createRuntimeBackupStore"]>
  createRuntimeCheckpointStore(
    db: D1Database,
    bucket: R2Bucket,
    masters: Readonly<Record<string, Uint8Array>>,
  ): ReturnType<FixtureModule["createRuntimeCheckpointStore"]>
}

/** Real R2 download -> authenticated native restore -> real D1 journal replay.
 * The final check is called after disposing and reopening both platform stores.
 */
export async function runCheckpointReplacementChecks(db: D1Database, bucket: R2Bucket, native: Native, root: string) {
  let assertions = 0
  const equal = (actual: unknown, expected: unknown, message: string) => {
    assertions++
    assert.deepEqual(actual, expected, message)
  }
  const scope = { accountID: "acc_replacement", workspaceID: "wrk_replacement" }
  const fixture = await native.createCheckpointFixture(root, scope)
  const history = native.createHistoryStore(db)
  const backups = native.createRuntimeBackupStore(bucket)
  const archives = {} as Record<"sqlite" | "files", CloudCheckpoint.Archive>
  for (const kind of ["sqlite", "files"] as const) {
    const bytes = await readFile(kind === "sqlite" ? fixture.sqliteArchive : fixture.filesArchive)
    const receipt = await backups.save(scope, {
      keyID: fixture.input[kind].keyID,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    })
    archives[kind] = {
      backupID: receipt.backupID,
      keyID: receipt.keyID,
      bytes: receipt.bytes,
      sha256: receipt.sha256,
      plaintext: fixture.input[kind].plaintext,
    }
  }
  const checkpoint: CloudCheckpoint.Checkpoint = {
    id: fixture.input.id,
    inventory: fixture.input.inventory,
    ...archives,
  }
  const checkpoints = native.createRuntimeCheckpointStore(db, bucket, { [checkpoint.sqlite.keyID]: fixture.master })
  const initialLease = await history.claim(scope, { expectedEpoch: 0, writerID: "writer_replacement_initial" })
  await checkpoints.publish(initialLease, checkpoint)
  const record = await checkpoints.read(scope)
  assert.ok(record)
  equal(record.data, checkpoint, "published checkpoint changed")

  async function download(storage: R2Bucket) {
    const store = native.createRuntimeBackupStore(storage)
    const sources = {} as Record<"sqlite" | "files", { source: string; key: Uint8Array }>
    for (const kind of ["sqlite", "files"] as const) {
      const archive = record!.data[kind]
      const opened = await store.open(scope, archive.backupID)
      equal(opened.manifest.sha256, archive.sha256, `${kind} R2 download did not match checkpoint`)
      equal(opened.manifest.bytes, archive.bytes, `${kind} R2 size did not match checkpoint`)
      const source = join(root, `download-${kind}-${crypto.randomUUID()}.mgptbackup`)
      // Synthetic, bounded fixture; production transport remains streaming.
      await writeFile(source, Buffer.from(await new Response(opened.body).arrayBuffer()), { flag: "wx", mode: 0o600 })
      sources[kind] = { source, key: native.deriveRuntimeBackupKey(scope, archive.keyID, fixture.master) }
    }
    return sources
  }

  const sources = await download(bucket)
  async function restore(input = record!.data) {
    return native.restoreCheckpoint({ parent: root, checkpoint: input, ...sources })
  }
  function request(database: D1Database) {
    return async (request: Request) => {
      if (["/v1/claim", "/v1/read"].includes(new URL(request.url).pathname)) {
        equal(
          ((await request.clone().json()) as { checkpointID?: string }).checkpointID,
          checkpoint.id,
          "recovery did not acknowledge authenticated baseline",
        )
      }
      return native.handleHistoryOutbound(request, { HISTORY: database }, { params: scope })
    }
  }
  async function files(directory: string) {
    equal(
      await readFile(join(directory, "synthetic/transcript.txt"), "utf8"),
      "synthetic checkpoint file payload",
      "restored text file changed",
    )
    equal(await readFile(join(directory, "synthetic/data.bin")), Buffer.from([0, 1, 127, 255]), "binary file changed")
  }

  const beforeFailedRestore = (await readdir(root)).sort()
  await assert.rejects(
    restore({
      ...checkpoint,
      files: { ...checkpoint.files, plaintext: { ...checkpoint.files.plaintext, sha256: "0".repeat(64) } },
    }),
  )
  equal((await readdir(root)).sort(), beforeFailedRestore, "bad files receipt left a partial generation")
  await assert.rejects(
    restore({
      ...checkpoint,
      inventory: {
        ...checkpoint.inventory,
        counts: { ...checkpoint.inventory.counts, events: checkpoint.inventory.counts.events + 1 },
      },
    }),
  )
  equal((await readdir(root)).sort(), beforeFailedRestore, "bad native inventory left a partial generation")
  equal(await history.epoch(scope), 1, "rejected restore claimed writer authority")

  const first = await restore()
  equal(
    first.files,
    { files: 2, directories: 4, bytes: Buffer.byteLength("synthetic checkpoint file payload") + 4 },
    "file materializer returned wrong inventory",
  )
  await files(first.directory)
  const initial = await native.recoverCheckpoint(first, request(db), "update")
  equal(initial.previousParts[0]?.data, { type: "text", text: "Restored chat content" }, "baseline chat text lost")
  equal(initial.parts[0]?.data, { type: "text", text: "New chat after checkpoint" }, "native update not projected")
  equal(initial.messages.length, 1, "baseline message lost")
  equal(initial.sessions[0]?.id, "ses_checkpoint", "baseline session lost")
  equal(
    initial.projects.map((row) => row.id).sort(),
    ["checkpoint_legacy", "checkpoint_project"],
    "legacy project disappeared during recovery",
  )
  equal(initial.events.length, 5, "baseline + new event identities not preserved")
  equal(
    (await history.read(scope, { checkpointID: checkpoint.id })).entries.length,
    1,
    "native update not persisted in D1",
  )

  // A second generation starts from the same old baseline, not the first DB.
  const second = await restore()
  assert.notEqual(second.directory, first.directory)
  assertions++
  await files(second.directory)
  await files(first.directory)
  const erased = await native.recoverCheckpoint(second, request(db), "delete")
  equal(
    erased.previousParts[0]?.data,
    { type: "text", text: "New chat after checkpoint" },
    "post-baseline D1 update not replayed",
  )
  equal(erased.sessions.length, 0, "native erase retained session")
  equal(erased.messages.length, 0, "native erase retained messages")
  equal(erased.parts.length, 0, "native erase retained parts")
  equal(erased.events.length, 1, "native erase retained old session event content")
  equal(erased.tombstones.length, 2, "baseline + new tombstones not preserved")

  const tampered = await restore()
  await writeFile(tampered.database, "untrusted generation")
  const epoch = await history.epoch(scope)
  await assert.rejects(native.recoverCheckpoint(tampered, request(db)))
  equal(await history.epoch(scope), epoch, "tampered SQLite reached the writer claim")
  const changedAfterOpen = await restore()
  await assert.rejects(native.recoverCheckpoint(changedAfterOpen, request(db), "tamper-after-open"))
  equal(await history.epoch(scope), epoch, "changed native event content passed startup inventory validation")
  await files(first.directory)

  return {
    get assertions() {
      return assertions
    },
    async afterRestart(database: D1Database, storage: R2Bucket) {
      const before = assertions
      const downloaded = await download(storage)
      const reopened = native.createRuntimeCheckpointStore(database, storage, {
        [checkpoint.sqlite.keyID]: fixture.master,
      })
      equal(await reopened.read(scope), record, "R2/D1 restart changed accepted checkpoint")
      const replacement = await native.restoreCheckpoint({ parent: root, checkpoint: record!.data, ...downloaded })
      const projection = await native.recoverCheckpoint(replacement, request(database))
      equal(projection.previousParts.length, 0, "old backup resurrected deleted content during startup")
      equal(projection.sessions.length, 0, "old backup resurrected deleted session after restart")
      equal(projection.messages.length, 0, "deleted messages resurrected after restart")
      equal(projection.parts.length, 0, "deleted parts resurrected after restart")
      equal(projection.events.length, 1, "deleted event content resurrected after restart")
      equal(
        projection.tombstones.map((row) => row.aggregate_id).sort(),
        ["checkpoint_deleted", "ses_checkpoint"],
        "replacement lost terminal identities",
      )
      equal(projection.projects.length, 2, "replacement lost surviving projects")
      await files(replacement.directory)
      const resumedHistory = native.createHistoryStore(database)
      const writer = await resumedHistory.claim(scope, {
        expectedEpoch: await resumedHistory.epoch(scope),
        writerID: "writer_resurrect_probe",
        checkpointID: checkpoint.id,
      })
      await assert.rejects(
        resumedHistory.append(writer, {
          id: "evt_resurrect_replaced",
          aggregateID: "ses_checkpoint",
          seq: 5,
          type: "session.created.1",
          data: { sessionID: "ses_checkpoint" },
        }),
        (error: unknown) => (error as { code?: string }).code === "conflict",
      )
      assertions++
      return assertions - before
    },
  }
}
