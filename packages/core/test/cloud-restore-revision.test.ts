import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Exit, Layer, Schema } from "effect"
import { CloudRestore } from "@mongolgpt/core/database/cloud-restore"
import { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { DatabaseCheckpoint } from "@mongolgpt/core/database/checkpoint"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { EventTable } from "@mongolgpt/core/event/sql"
import { ProjectHistory } from "@mongolgpt/core/project/history"
import { ProjectTable } from "@mongolgpt/core/project/sql"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { MessageTable, SessionTable } from "@mongolgpt/core/session/sql"
import { SessionV1 } from "@mongolgpt/core/v1/session"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { Project } from "@mongolgpt/schema/project"
import { Session } from "@mongolgpt/schema/session"
import { tmpdir } from "./fixture/tmpdir"

const keyID = "key_restore_revision"
const key = Buffer.from("42".repeat(32), "hex")
const checkpointID = "11111111-1111-4111-8111-111111111111"
const revisionID = "22222222-2222-4222-8222-222222222222"
const projectID = Project.ID.make("project_restore_revision")
const sessionID = Session.ID.make("ses_restore_revision")

type Entry = { cursor: number; deleted: false; event: EventV2.SerializedEvent }

const layers = (filename: string, options?: EventV2.LayerOptions) =>
  Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
    Layer.provideMerge(EventV2.layerWith(options)),
    Layer.provideMerge(Database.layerFromPath(filename)),
  )

describe("cloud restore paired SQLite file revisions", () => {
  test("restores the paired SQLite revision, preserves native rows, and admits only after replay", async () => {
    await using temp = await tmpdir()
    const fixture = await pairedFixture(temp.path)
    const restored = await restoreFixture(temp.path, fixture, { mutateInputAfterStart: true })

    expect(restored.revision).toEqual(fixture.revision)
    expect(restored.verifiedInventory).toEqual(fixture.revisionInventory)
    expect(restored.verifiedInventory.counts.events).toBeGreaterThan(fixture.checkpoint.inventory.counts.events)
    expect(await readFile(join(restored.directory, "synthetic/revision.txt"), "utf8")).toBe("revision files")

    const { request, calls, claims } = cloudFixture(fixture.delta, fixture.revision.id)
    const runtime = CloudRestore.createRuntime(restored, request)
    expect(Exit.isFailure(await Effect.runPromiseExit(runtime.admission))).toBe(true)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        expect(Exit.isFailure(yield* runtime.admission.pipe(Effect.exit))).toBe(true)
        yield* events.recover
        yield* runtime.admission
        return {
          events: yield* db.select().from(EventTable).all().pipe(Effect.orDie),
          projects: yield* db.select().from(ProjectTable).all().pipe(Effect.orDie),
          sessions: yield* db.select().from(SessionTable).all().pipe(Effect.orDie),
          messages: yield* db.select().from(MessageTable).all().pipe(Effect.orDie),
          accounts: yield* db.all(sql`SELECT email FROM account`),
          queued: yield* db.all(sql`SELECT id, delivery FROM session_input`),
        }
      }).pipe(Effect.provide(runtime.layer), Effect.scoped),
    )

    expect(calls).toEqual(["/v1/epoch", "/v1/claim", "/v1/read", "/v1/read"])
    expect(claims).toEqual([{ checkpointID, filesRevisionID: revisionID }])
    expect(result.events.map((event) => String(event.id)).sort()).toEqual([
      "evt_restore_message",
      "evt_restore_project",
      "evt_restore_remote_delta",
      "evt_restore_session",
    ])
    expect(result.projects).toHaveLength(1)
    expect(result.sessions).toHaveLength(1)
    expect(result.messages.map((message) => String(message.id)).sort()).toEqual([
      "msg_restore_base",
      "msg_restore_delta",
    ])
    expect(result.accounts).toEqual([{ email: "revision@example.test" }])
    expect(result.queued).toEqual([{ id: "msg_restore_pending", delivery: "queue" }])
  }, 30_000)

  test("rejects revisions that are not bound to the baseline checkpoint and selected file archive", async () => {
    await using temp = await tmpdir()
    const fixture = await pairedFixture(temp.path)

    await expect(
      restoreFixture(temp.path, {
        ...fixture,
        revision: { ...fixture.revision, checkpointID: "33333333-3333-4333-8333-333333333333" },
      }),
    ).rejects.toThrow()
    await expectRestoreGenerations(temp.path, [])

    await expect(
      restoreFixture(temp.path, {
        ...fixture,
        checkpoint: { ...fixture.checkpoint, files: fixture.baselineFiles },
      }),
    ).rejects.toThrow()
    await expectRestoreGenerations(temp.path, [])

    await expect(
      restoreFixture(temp.path, {
        ...fixture,
        revision: {
          ...fixture.revision,
          sqlite: { ...fixture.revision.sqlite!, backupID: fixture.revision.archive.backupID },
        },
      }),
    ).rejects.toThrow()
    await expectRestoreGenerations(temp.path, [])

    await expect(
      restoreFixture(temp.path, {
        ...fixture,
        revision: { ...fixture.revision, sequence: 2, previousID: null },
      }),
    ).rejects.toThrow()
    await expectRestoreGenerations(temp.path, [])

    await expect(
      restoreFixture(temp.path, {
        ...fixture,
        revision: { ...fixture.revision, sequence: 2, previousID: fixture.revision.id },
      }),
    ).rejects.toThrow()
    await expectRestoreGenerations(temp.path, [])
  }, 30_000)

  test("rejects archives or restored images that do not match the selected SQLite revision", async () => {
    await using temp = await tmpdir()
    const fixture = await pairedFixture(temp.path)

    await expect(
      restoreFixture(temp.path, {
        ...fixture,
        revisionSqliteArchive: fixture.baselineSqliteArchive,
      }),
    ).rejects.toThrow()

    const restored = await restoreFixture(temp.path, fixture)
    await mutate(restored.database, (db) => {
      db.query("UPDATE event SET data = json_set(data, '$.info.agent', ?) WHERE id = ?").run(
        "tampered",
        "evt_restore_message",
      )
    })
    const runtime = CloudRestore.createRuntime(restored, cloudFixture(fixture.delta, fixture.revision.id).request)
    const opened = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.recover
      }).pipe(Effect.provide(runtime.layer), Effect.scoped),
    )
    expect(Exit.isFailure(opened)).toBe(true)

    const generations = await restoreGenerations(temp.path)
    const bytes = await readFile(fixture.revisionSqliteArchive)
    bytes[bytes.length - 1] ^= 1
    await writeFile(fixture.revisionSqliteArchive, bytes)
    await expect(restoreFixture(temp.path, fixture)).rejects.toThrow()
    await expectRestoreGenerations(temp.path, generations)
  }, 30_000)

  test("keeps admission closed when the revision snapshot has unacknowledged local history", async () => {
    await using temp = await tmpdir()
    const fixture = await pairedFixture(temp.path, { extraLocalEvent: true })
    const restored = await restoreFixture(temp.path, fixture)
    const runtime = CloudRestore.createRuntime(restored, cloudFixture(fixture.delta, fixture.revision.id).request)

    const recovered = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.recover
      }).pipe(Effect.provide(runtime.layer), Effect.scoped),
    )

    expect(Exit.isFailure(recovered)).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(runtime.admission))).toBe(true)
  }, 30_000)
})

async function pairedFixture(root: string, options: { extraLocalEvent?: boolean } = {}) {
  const baselineSource = join(root, `${crypto.randomUUID()}-baseline.sqlite`)
  const baselineEvents = await seedBaseline(baselineSource)
  const baselineSqlite = await backupSqlite(root, "baseline-sqlite", baselineSource, archiveID("1"))
  const baselineInventory = await inspectRestored(root, baselineSqlite.path, baselineSqlite.report)
  const baselineFiles = await backupFiles(
    root,
    "baseline-files",
    { "synthetic/baseline.txt": "baseline files" },
    archiveID("2"),
  )

  const revisionSource = join(root, `${crypto.randomUUID()}-revision.sqlite`)
  const delta = await seedRevision(revisionSource, baselineEvents, options)
  await preserveNativeRows(revisionSource)
  const revisionSqlite = await backupSqlite(root, "revision-sqlite", revisionSource, archiveID("3"))
  const revisionInventory = await inspectRestored(root, revisionSqlite.path, revisionSqlite.report)
  const revisionFiles = await backupFiles(
    root,
    "revision-files",
    { "synthetic/revision.txt": "revision files" },
    archiveID("4"),
  )

  const checkpoint: CloudCheckpoint.Checkpoint = {
    id: checkpointID,
    inventory: baselineInventory,
    sqlite: baselineSqlite.archive,
    files: revisionFiles.archive,
  }
  const revision: CloudCheckpoint.FileRevision = {
    id: revisionID,
    checkpointID,
    sequence: 1,
    previousID: null,
    archive: revisionFiles.archive,
    sqlite: revisionSqlite.archive,
  }
  return {
    checkpoint,
    revision,
    revisionInventory,
    delta: pageEntries(delta),
    baselineFiles: baselineFiles.archive,
    baselineSqliteArchive: baselineSqlite.path,
    revisionSqliteArchive: revisionSqlite.path,
    revisionFilesArchive: revisionFiles.path,
  }
}

async function restoreFixture(
  root: string,
  fixture: Awaited<ReturnType<typeof pairedFixture>>,
  options: { mutateInputAfterStart?: boolean } = {},
) {
  const input: Parameters<typeof CloudRestore.restore>[0] = {
    parent: root,
    checkpoint: structuredClone(fixture.checkpoint),
    revision: structuredClone(fixture.revision),
    sqlite: { source: fixture.revisionSqliteArchive, key: new Uint8Array(key) },
    files: { source: fixture.revisionFilesArchive, key: new Uint8Array(key) },
  }
  const pending = Effect.runPromise(CloudRestore.restore(input))
  if (options.mutateInputAfterStart) {
    const mutable = input as {
      checkpoint: { files: CloudCheckpoint.Archive }
      revision?: CloudCheckpoint.FileRevision
      sqlite: { key: Uint8Array }
      files: { key: Uint8Array }
    }
    input.sqlite.key.fill(0)
    input.files.key.fill(0)
    mutable.checkpoint.files = fixture.baselineFiles
    mutable.revision = { ...fixture.revision, sqlite: { ...fixture.revision.archive } }
  }
  return await pending
}

async function seedBaseline(filename: string) {
  const wire: EventV2.SerializedEvent[] = []
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* events.publish(
        ProjectHistory.Changed,
        {
          projectID,
          change: {
            type: "saved",
            info: {
              id: projectID,
              worktree: "/restore/revision",
              name: "Restore Revision",
              time: { created: 1000, updated: 1001 },
              sandboxes: [],
            },
          },
        },
        { id: EventV2.ID.make("evt_restore_project") },
      )
      yield* events.publish(
        SessionV1.Event.Created,
        {
          sessionID,
          info: Schema.decodeUnknownSync(SessionV1.SessionInfo)({
            id: sessionID,
            slug: "restore-revision",
            projectID,
            directory: "/restore/revision",
            title: "Restore Revision",
            version: "test",
            time: { created: 1100, updated: 1101 },
          }),
        },
        { id: EventV2.ID.make("evt_restore_session") },
      )
      yield* events.publish(
        SessionV1.Event.MessageUpdated,
        {
          sessionID,
          info: Schema.decodeUnknownSync(SessionV1.Info)({
            id: "msg_restore_base",
            sessionID,
            role: "user",
            time: { created: 1200 },
            agent: "build",
            model: { providerID: "mongolgpt", modelID: "restore-model" },
          }),
        },
        { id: EventV2.ID.make("evt_restore_message") },
      )
    }),
    {
      journal: {
        append: (event) =>
          Effect.sync(() => {
            wire.push(event)
          }),
      },
    },
  )
  return wire
}

async function seedRevision(
  filename: string,
  baseline: EventV2.SerializedEvent[],
  options: { extraLocalEvent?: boolean },
) {
  const delta: EventV2.SerializedEvent[] = []
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      for (const event of baseline) yield* events.replay(event)
      yield* events.publish(
        SessionV1.Event.MessageUpdated,
        {
          sessionID,
          info: Schema.decodeUnknownSync(SessionV1.Info)({
            id: "msg_restore_delta",
            sessionID,
            role: "user",
            time: { created: 1300 },
            agent: "build",
            model: { providerID: "mongolgpt", modelID: "restore-model" },
          }),
        },
        { id: EventV2.ID.make("evt_restore_remote_delta") },
      )
      if (options.extraLocalEvent) {
        yield* events.publish(
          SessionV1.Event.MessageUpdated,
          {
            sessionID,
            info: Schema.decodeUnknownSync(SessionV1.Info)({
              id: "msg_restore_extra",
              sessionID,
              role: "user",
              time: { created: 1400 },
              agent: "build",
              model: { providerID: "mongolgpt", modelID: "restore-model" },
            }),
          },
          { id: EventV2.ID.make("evt_restore_extra_local") },
        )
      }
    }),
    {
      journal: {
        append: (event) =>
          Effect.sync(() => {
            if (event.id === "evt_restore_remote_delta") delta.push(event)
          }),
      },
    },
  )
  return delta
}

async function preserveNativeRows(filename: string) {
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`
        INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
        VALUES ('acct_restore_revision', 'revision@example.test', 'https://account.example.test', 'access', 'refresh', 9999, 1, 2)
      `)
      yield* db.run(sql`
        INSERT INTO account_state (id, active_account_id, active_org_id)
        VALUES (1, 'acct_restore_revision', 'org_restore_revision')
      `)
      yield* db.run(sql`
        INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created)
        VALUES ('msg_restore_pending', ${sessionID}, ${JSON.stringify({ text: "preserve" })}, 'queue', 99, 1234)
      `)
    }),
  )
}

async function backupSqlite(root: string, name: string, source: string, backupID: string) {
  const destination = join(root, `${crypto.randomUUID()}-${name}.mgptbackup`)
  const report = await Effect.runPromise(DatabaseBackup.create({ source, destination, key: Buffer.from(key) }))
  return { path: destination, report, archive: await archive(destination, backupID, report) }
}

async function backupFiles(root: string, name: string, files: Record<string, string>, backupID: string) {
  const source = join(root, `${crypto.randomUUID()}-${name}.sqlite`)
  await seedFileManifest(source, files)
  return backupSqlite(root, name, source, backupID)
}

async function seedFileManifest(filename: string, files: Record<string, string>) {
  const sqlite = await import("bun:sqlite")
  const db = new sqlite.Database(filename)
  try {
    db.exec(
      "CREATE TABLE file (path TEXT PRIMARY KEY, type TEXT NOT NULL, mode INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT, content BLOB)",
    )
    const insert = db.query("INSERT INTO file VALUES (?, ?, ?, ?, ?, ?)")
    insert.run("synthetic", "directory", 448, 0, null, null)
    for (const [path, value] of Object.entries(files)) {
      const content = Buffer.from(value)
      insert.run(path, "file", 384, content.length, checksum(content), content)
    }
  } finally {
    db.close()
  }
}

async function inspectRestored(root: string, source: string, expected: DatabaseBackup.Report) {
  const destination = join(root, `${crypto.randomUUID()}-inspect.sqlite`)
  const report = await Effect.runPromise(DatabaseBackup.restore({ source, destination, key: Buffer.from(key) }))
  expect(report).toEqual(expected)
  return await Effect.runPromise(DatabaseCheckpoint.inspect({ source: destination, expected }))
}

async function archive(
  filename: string,
  backupID: string,
  report: DatabaseBackup.Report,
): Promise<CloudCheckpoint.Archive> {
  const info = await lstat(filename)
  const bytes = await readFile(filename)
  return {
    backupID,
    keyID,
    bytes: info.size,
    sha256: checksum(bytes),
    plaintext: { bytes: report.bytes, sha256: report.sha256 },
  }
}

async function withDatabase<A, E, R>(filename: string, effect: Effect.Effect<A, E, R>, options?: EventV2.LayerOptions) {
  return await Effect.runPromise(
    effect.pipe(Effect.provide(layers(filename, options) as Layer.Layer<R>), Effect.scoped),
  )
}

async function restoreGenerations(root: string) {
  return (await readdir(root)).filter((name) => name.startsWith(".mongolgpt-restore-")).sort()
}

async function expectRestoreGenerations(root: string, expected: string[]) {
  expect(await restoreGenerations(root)).toEqual(expected)
}

function cloudFixture(entries: Entry[], filesRevisionID: string) {
  const calls: string[] = []
  const claims: Array<{ checkpointID?: string; filesRevisionID?: string }> = []
  const reply = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
  const request = async (request: Request) => {
    const route = new URL(request.url).pathname
    calls.push(route)
    if (route === "/v1/epoch") return reply({ epoch: 0 })
    if (route === "/v1/claim") {
      const body = (await request.json()) as { writerID: string; checkpointID?: string; filesRevisionID?: string }
      claims.push({ checkpointID: body.checkpointID, filesRevisionID: body.filesRevisionID })
      return reply({ epoch: 1, writerID: body.writerID })
    }
    if (route === "/v1/read") {
      const body = (await request.json()) as { after: number; checkpointID?: string }
      expect(body.checkpointID).toBe(checkpointID)
      const remaining = entries.filter((entry) => entry.cursor > body.after)
      const page = remaining.slice(0, 10)
      return reply({ entries: page, cursor: page.at(-1)?.cursor ?? body.after, hasMore: remaining.length > 10 })
    }
    throw new Error("unexpected cloud restore route")
  }
  expect(filesRevisionID).toBe(revisionID)
  return { request, calls, claims }
}

function pageEntries(events: EventV2.SerializedEvent[]): Entry[] {
  return events.map((event, index) => ({ cursor: index + 1, deleted: false, event }))
}

function checksum(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function archiveID(seed: string) {
  return `${seed.repeat(8)}-${seed.repeat(4)}-4${seed.repeat(3)}-8${seed.repeat(3)}-${seed.repeat(12)}`
}

async function mutate(filename: string, run: (db: InstanceType<(typeof import("bun:sqlite"))["Database"]>) => void) {
  const sqlite = await import("bun:sqlite")
  const db = new sqlite.Database(filename)
  try {
    run(db)
  } finally {
    db.close()
  }
}
