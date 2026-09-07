import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import type { createHistoryStore, HistoryEvent, HistoryLease, HistoryScope } from "../src/history.ts"
import type { CheckpointFixture } from "./fixtures/checkpoint-native.ts"

type CheckpointInventory = CloudCheckpoint.Inventory
type RuntimeCheckpointInput = CloudCheckpoint.Checkpoint
type CheckpointRecord = { data: RuntimeCheckpointInput; digest: string }
type RuntimeBackupManifest = { backupID: string; keyID: string; bytes: number; sha256: string }
type RuntimeBackupStore = {
  save(scope: HistoryScope, input: { keyID: string; body: ReadableStream<Uint8Array> }): Promise<RuntimeBackupManifest>
}
type RuntimeCheckpointStore = {
  publish(lease: HistoryLease, input: RuntimeCheckpointInput): Promise<CheckpointRecord>
  read(scope: HistoryScope): Promise<CheckpointRecord | undefined>
}
type RuntimeErrorCode = "invalid" | "not_found" | "unavailable"
interface NativeCheckpointModule {
  createHistoryStore: typeof createHistoryStore
  createRuntimeBackupStore(bucket: R2Bucket): RuntimeBackupStore
  createRuntimeCheckpointStore(
    db: Pick<D1Database, "prepare" | "batch">,
    bucket: R2Bucket,
    masters: Readonly<Record<string, Uint8Array>>,
  ): RuntimeCheckpointStore
  createCheckpointFixture(root: string, scope?: HistoryScope): Promise<CheckpointFixture>
}

let assertionCount = 0

export async function runCheckpointChecks(
  db: D1Database,
  bucket: R2Bucket,
  native: NativeCheckpointModule,
  root: string,
): Promise<number> {
  assertionCount = 0
  const history = native.createHistoryStore(db)
  const backupStore = native.createRuntimeBackupStore(bucket)
  const scope = { accountID: "acc_checkpoint", workspaceID: "wrk_checkpoint" }
  const fixture = await native.createCheckpointFixture(root, scope)
  const checkpointStore = native.createRuntimeCheckpointStore(db, bucket, {
    [fixture.input.sqlite.keyID]: fixture.master,
  })
  const input = await saveInput(backupStore, scope, fixture)

  ok(await history.checkpoint(scope).then((value) => value === undefined), "fresh scope already had a checkpoint")
  const lease = await history.claim(scope, { expectedEpoch: 0, writerID: "writer_checkpoint" })
  await checkpointStore.publish(lease, input)
  const baseline = await history.checkpoint(scope)
  ok(baseline, "checkpoint publish did not store a baseline")
  equal(baseline!.data.id, input.id, "stored checkpoint id changed")
  ok(/^[0-9a-f]{64}$/.test(baseline!.digest), "checkpoint digest was not a sha256 hex string")
  deepEqual(baseline!.data, input, "stored checkpoint input changed")
  deepEqual(await checkpointStore.read(scope), baseline, "runtime checkpoint read differed from D1 record")
  deepEqual(await checkpointStore.publish(lease, input), baseline, "same-lease checkpoint retry changed the receipt")

  const session = aggregate(input.inventory, "ses_checkpoint")
  await history.append(lease, event("evt_after_checkpoint_before_claim", session.id, session.seq + 1))
  equal(
    (await history.read(scope, { checkpointID: input.id })).entries.length,
    1,
    "append before next claim was not replayable",
  )
  deepEqual(await checkpointStore.publish(lease, input), baseline, "same-lease retry after append rewound checkpoint")
  equal(
    (await history.read(scope, { checkpointID: input.id })).entries.length,
    1,
    "checkpoint retry rewound appended history",
  )

  await expectCode(history.read(scope), "conflict")
  await expectCode(history.read(scope, { checkpointID: crypto.randomUUID() }), "conflict")
  const beforeGuard = await history.epoch(scope)
  await expectCode(history.claim(scope, { expectedEpoch: beforeGuard, writerID: "writer_missing_guard" }), "conflict")
  await expectCode(
    history.claim(scope, {
      expectedEpoch: beforeGuard,
      writerID: "writer_wrong_guard",
      checkpointID: crypto.randomUUID(),
    }),
    "conflict",
  )
  equal(await history.epoch(scope), beforeGuard, "failed guarded claim advanced the writer epoch")
  const guarded = await history.claim(scope, {
    expectedEpoch: beforeGuard,
    writerID: "writer_after_checkpoint",
    checkpointID: input.id,
  })
  await expectCode(
    history.claim(scope, { expectedEpoch: beforeGuard, writerID: "writer_stale_claim", checkpointID: input.id }),
    "fenced",
  )
  await expectCode(history.append(lease, event("evt_stale_writer", session.id, session.seq + 2)), "fenced")
  await expectCode(checkpointStore.publish(lease, input), "fenced")
  await expectCode(
    history.publishCheckpoint(guarded, { ...input, id: "44444444-4444-4444-8444-444444444444" }),
    "conflict",
  )
  equal((await history.checkpoint(scope))?.data.id, input.id, "conflicting checkpoint proposal overwrote baseline")

  await history.append(guarded, event("evt_after_checkpoint", session.id, session.seq + 2))
  const delta = await history.read(scope, { checkpointID: input.id })
  equal(delta.entries.length, 2, "append after checkpoint was not replayable")
  equal(delta.entries[0]?.deleted, false, "append after checkpoint was stored as a tombstone")

  const baselineEvent = input.inventory.eventIDs[0]
  ok(baselineEvent, "fixture did not expose checkpoint event ids")
  await expectCode(history.append(guarded, event(baselineEvent!.id, "checkpoint_new_aggregate", 0)), "conflict")
  const tombstone = input.inventory.tombstones[0]
  ok(tombstone, "fixture did not include a baseline tombstone")
  await expectCode(history.append(guarded, event("evt_resurrect_baseline", tombstone!.aggregateID, 0)), "conflict")
  await expectCode(history.append(guarded, event(tombstone!.id, session.id, session.seq + 3)), "conflict")

  await existingHistoryRejects(db, bucket, native, root)
  await concurrencyHasOneWinner(db, bucket, native, root)
  await invalidInventoriesReject(history, input)
  await invalidRefsReject(db, bucket, native, root)
  await rollbackProbe(db, bucket, native, root)

  const otherScope = { accountID: "acc_checkpoint_other", workspaceID: "wrk_checkpoint" }
  equal((await history.read(otherScope)).entries.length, 0, "checkpoint affected another tenant")
  const otherLease = await history.claim(otherScope, { expectedEpoch: 0, writerID: "writer_other_tenant" })
  await expectRuntimeCode(checkpointStore.publish(otherLease, input), "not_found")
  equal(await history.checkpoint(otherScope), undefined, "cross-tenant archive published another account's checkpoint")

  const legacy = await db
    .prepare("SELECT seq FROM runtime_history_session WHERE account_id = ? AND workspace_id = ? AND session_id = ?")
    .bind(scope.accountID, scope.workspaceID, "checkpoint_legacy")
    .first<{ seq: number }>()
  equal(legacy?.seq, -1, "unjournaled legacy project was seeded with an invented event")
  await history.append(guarded, event("evt_legacy_first", "checkpoint_legacy", 0))
  await expectCode(
    history.append(guarded, event("evt_resurrect_next", tombstone!.aggregateID, tombstone!.seq + 1)),
    "conflict",
  )

  return assertionCount
}

async function existingHistoryRejects(db: D1Database, bucket: R2Bucket, native: NativeCheckpointModule, root: string) {
  const history = native.createHistoryStore(db)
  const scope = { accountID: "acc_checkpoint_existing", workspaceID: "wrk_checkpoint" }
  const fixture = await native.createCheckpointFixture(root, scope)
  const input = await saveInput(native.createRuntimeBackupStore(bucket), scope, fixture)
  const store = native.createRuntimeCheckpointStore(db, bucket, { [fixture.input.sqlite.keyID]: fixture.master })
  const lease = await history.claim(scope, { expectedEpoch: 0, writerID: "writer_existing" })
  await history.append(lease, event("evt_existing_history", "existing_session", 0))
  await expectCode(store.publish(lease, input), "conflict")
  equal(await history.checkpoint(scope), undefined, "checkpoint overwrote existing history")
}

async function concurrencyHasOneWinner(db: D1Database, bucket: R2Bucket, native: NativeCheckpointModule, root: string) {
  const history = native.createHistoryStore(db)
  const scope = { accountID: "acc_checkpoint_race", workspaceID: "wrk_checkpoint" }
  const fixture = await native.createCheckpointFixture(root, scope)
  const first = await saveInput(native.createRuntimeBackupStore(bucket), scope, fixture)
  const second = { ...first, id: "22222222-2222-4222-8222-222222222222" }
  const store = native.createRuntimeCheckpointStore(db, bucket, { [fixture.input.sqlite.keyID]: fixture.master })
  const lease = await history.claim(scope, { expectedEpoch: 0, writerID: "writer_race" })
  const race = await Promise.allSettled([store.publish(lease, first), store.publish(lease, second)])
  equal(race.filter((item) => item.status === "fulfilled").length, 1, "checkpoint race did not have one winner")
  ok(await history.checkpoint(scope), "checkpoint race stored no winner")
}

async function invalidInventoriesReject(
  history: ReturnType<typeof createHistoryStore>,
  baseline: RuntimeCheckpointInput,
) {
  const cases: [string, (input: RuntimeCheckpointInput) => RuntimeCheckpointInput][] = [
    [
      "journal flag",
      (input) => mutate(input, { projects: input.inventory.projects.map((row) => ({ ...row, journaled: false })) }),
    ],
    [
      "event count",
      (input) => mutate(input, { counts: { ...input.inventory.counts, events: input.inventory.counts.events + 1 } }),
    ],
    [
      "aggregate head",
      (input) =>
        mutate(input, {
          aggregates: input.inventory.aggregates.map((item, index) =>
            index === 0 ? { ...item, seq: item.seq + 1 } : item,
          ),
        }),
    ],
    [
      "event owner",
      (input) =>
        mutate(input, {
          eventIDs: input.inventory.eventIDs.map((item, index) =>
            index === 0 ? { ...item, aggregateID: "wrong_aggregate" } : item,
          ),
        }),
    ],
  ]
  for (const [name, change] of cases) {
    const scope = { accountID: `acc_checkpoint_bad_${name.replace(/\W/g, "_")}`, workspaceID: "wrk_checkpoint" }
    const input = change(baseline)
    const lease = await history.claim(scope, { expectedEpoch: 0, writerID: `writer_${scope.accountID}` })
    await expectCode(history.publishCheckpoint(lease, input), "invalid_input")
    equal(await history.checkpoint(scope), undefined, `invalid inventory ${name} published a checkpoint`)
  }
}

async function invalidRefsReject(db: D1Database, bucket: R2Bucket, native: NativeCheckpointModule, root: string) {
  const scope = { accountID: "acc_checkpoint_bad_refs", workspaceID: "wrk_checkpoint" }
  const fixture = await native.createCheckpointFixture(root, scope)
  const saved = await saveInput(native.createRuntimeBackupStore(bucket), scope, fixture)
  const history = native.createHistoryStore(db)
  const lease = await history.claim(scope, { expectedEpoch: 0, writerID: "writer_bad_refs" })
  const variants: [
    string,
    RuntimeErrorCode,
    (scope: HistoryScope, input: RuntimeCheckpointInput) => Promise<RuntimeCheckpointInput>,
  ][] = [
    [
      "missing key",
      "unavailable",
      async (_scope, input) => ({ ...input, sqlite: { ...input.sqlite, keyID: "key_missing" } }),
    ],
    ["stale key", "invalid", async (_scope, input) => input],
    [
      "missing object",
      "not_found",
      async (_scope, input) => ({
        ...input,
        sqlite: { ...input.sqlite, backupID: "33333333-3333-4333-8333-333333333333" },
      }),
    ],
    [
      "wrong encrypted bytes",
      "invalid",
      async (_scope, input) => ({ ...input, sqlite: { ...input.sqlite, bytes: input.sqlite.bytes + 1 } }),
    ],
    [
      "corrupt blob",
      "invalid",
      async (scope, input) => {
        const prefix = objectPrefix(scope, input.sqlite.backupID)
        const object = await bucket.get(chunkKey(prefix, 0))
        const bytes = Buffer.from(await object!.arrayBuffer())
        bytes[bytes.length - 17] ^= 1
        await bucket.put(chunkKey(prefix, 0), bytes)
        return input
      },
    ],
  ]
  for (const [name, code, change] of variants) {
    const input = await change(scope, saved)
    const keys =
      name === "missing key"
        ? {}
        : { [fixture.input.sqlite.keyID]: name === "stale key" ? new Uint8Array(32).fill(7) : fixture.master }
    const store = native.createRuntimeCheckpointStore(db, bucket, keys)
    await expectRuntimeCode(store.publish(lease, input), code)
    equal(await history.checkpoint(scope), undefined, `invalid ref ${name} published a checkpoint`)
  }
}

async function rollbackProbe(db: D1Database, bucket: R2Bucket, native: NativeCheckpointModule, root: string) {
  const table = "runtime_history_checkpoint_event"
  equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .bind(table)
        .first<{ count: number }>()
    )?.count,
    1,
    "checkpoint event table missing for rollback trigger probe",
  )
  const scope = { accountID: "acc_checkpoint_rollback", workspaceID: "wrk_checkpoint" }
  const fixture = await native.createCheckpointFixture(root, scope)
  const input = await saveInput(native.createRuntimeBackupStore(bucket), scope, fixture)
  const history = native.createHistoryStore(db)
  const store = native.createRuntimeCheckpointStore(db, bucket, { [fixture.input.sqlite.keyID]: fixture.master })
  const lease = await history.claim(scope, { expectedEpoch: 0, writerID: "writer_rollback" })
  await db
    .prepare(
      `CREATE TRIGGER checkpoint_injected_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected private checkpoint detail'); END`,
    )
    .run()
  try {
    await expectRejected(store.publish(lease, input), "checkpoint failure trigger did not reject")
    equal(await history.checkpoint(scope), undefined, "failed checkpoint transaction left a baseline")
    equal(
      await countRows(db, "runtime_history_checkpoint", scope),
      0,
      "failed checkpoint transaction left a checkpoint header",
    )
    equal(
      await countRows(db, "runtime_history_checkpoint_event", scope),
      0,
      "failed checkpoint transaction left reserved event ids",
    )
    equal(
      await countRows(db, "runtime_history_session", scope),
      0,
      "failed checkpoint transaction left seeded aggregate heads",
    )
  } finally {
    await db.prepare("DROP TRIGGER checkpoint_injected_failure").run()
  }
}

async function saveInput(
  store: RuntimeBackupStore,
  scope: HistoryScope,
  fixture: CheckpointFixture,
): Promise<RuntimeCheckpointInput> {
  const sqliteBytes = await readFile(fixture.sqliteArchive)
  const filesBytes = await readFile(fixture.filesArchive)
  const sqlite = await store.save(scope, { keyID: fixture.input.sqlite.keyID, body: streamFrom(sqliteBytes) })
  const files = await store.save(scope, { keyID: fixture.input.files.keyID, body: streamFrom(filesBytes) })
  equal(sqlite.sha256, checksum(sqliteBytes), "sqlite R2 manifest hash changed")
  equal(files.sha256, checksum(filesBytes), "files R2 manifest hash changed")
  return {
    id: fixture.input.id,
    inventory: fixture.input.inventory,
    sqlite: {
      backupID: sqlite.backupID,
      keyID: sqlite.keyID,
      bytes: sqlite.bytes,
      sha256: sqlite.sha256,
      plaintext: fixture.input.sqlite.plaintext,
    },
    files: {
      backupID: files.backupID,
      keyID: files.keyID,
      bytes: files.bytes,
      sha256: files.sha256,
      plaintext: fixture.input.files.plaintext,
    },
  }
}

function mutate(input: RuntimeCheckpointInput, inventory: Partial<CheckpointInventory>): RuntimeCheckpointInput {
  return { ...input, inventory: { ...input.inventory, ...inventory } }
}

function aggregate(inventory: CheckpointInventory, id: string) {
  const value = inventory.aggregates.find((item) => item.id === id)
  if (!value) throw new Error(`checkpoint fixture did not include aggregate ${id}`)
  return value
}

function event(
  id: string,
  aggregateID: string,
  seq: number,
  data: Record<string, unknown> = { checkpoint: true },
): HistoryEvent {
  return { id, aggregateID, seq, type: "session.created:1", data }
}

function streamFrom(value: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value)
      controller.close()
    },
  })
}

function objectPrefix(input: HistoryScope, backupID: string) {
  return `runtime-backups/v1/${input.accountID}/${input.workspaceID}/${backupID}`
}

function chunkKey(prefix: string, index: number) {
  return `${prefix}/${String(index).padStart(6, "0")}.bin`
}

function checksum(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

async function countRows(db: D1Database, table: string, scope: HistoryScope) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`unsafe table name ${table}`)
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE account_id = ? AND workspace_id = ?`)
    .bind(scope.accountID, scope.workspaceID)
    .first<{ count: number }>()
  return row?.count ?? 0
}

function equal<T>(actual: T, expected: T, message: string) {
  assertionCount++
  assert.equal(actual, expected, message)
}

function deepEqual(actual: unknown, expected: unknown, message: string) {
  assertionCount++
  assert.deepEqual(actual, expected, message)
}

function ok(value: unknown, message: string) {
  assertionCount++
  assert.ok(value, message)
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise
  } catch (error) {
    ok(
      error instanceof Error && !String(error).includes("injected private checkpoint detail"),
      "private checkpoint detail leaked",
    )
    equal((error as { code?: string }).code, code, `expected ${code}`)
    return
  }
  throw new Error(`expected ${code}`)
}

async function expectRejected(promise: Promise<unknown>, message: string) {
  try {
    await promise
  } catch (error) {
    ok(error instanceof Error, message)
    ok(!String(error).includes("injected private checkpoint detail"), "private checkpoint detail leaked")
    return
  }
  throw new Error(message)
}

async function expectRuntimeCode(promise: Promise<unknown>, code: RuntimeErrorCode) {
  try {
    await promise
  } catch (error) {
    equal((error as { name?: string }).name, "RuntimeBackupError", `expected RuntimeBackupError ${code}`)
    equal((error as { code?: string }).code, code, `expected RuntimeBackupError ${code}`)
    ok(!String(error).includes("injected private checkpoint detail"), "private checkpoint detail leaked")
    return
  }
  throw new Error(`expected RuntimeBackupError ${code}`)
}
