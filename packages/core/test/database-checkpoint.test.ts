import { describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { copyFile, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { DatabaseCheckpoint } from "@mongolgpt/core/database/checkpoint"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { ProjectHistory } from "@mongolgpt/core/project/history"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { SessionV1 } from "@mongolgpt/core/v1/session"
import { Project } from "@mongolgpt/schema/project"
import { Session } from "@mongolgpt/schema/session"
import { tmpdir } from "./fixture/tmpdir"

const marker = "synthetic-checkpoint-token-not-a-real-secret"
const ownerMarker = "synthetic-checkpoint-owner-not-a-real-owner"
const genericError = "Сэргээсэн түүхийн эх төлөвийг баталгаажуулж чадсангүй. Өгөгдлийг өөрчлөөгүй."
const ioTimeout = 30_000

const projectA = Project.ID.make("project_checkpoint_a")
const projectB = Project.ID.make("project_checkpoint_b")
const projectLegacy = Project.ID.make("project_checkpoint_legacy")
const sessionA = Session.ID.descending("ses_checkpoint_a")
const sessionB = Session.ID.descending("ses_checkpoint_b")
const sessionLegacy = Session.ID.descending("ses_checkpoint_legacy")
const sessionDeleted = Session.ID.descending("ses_checkpoint_deleted")

const eventIDs = {
  projectASaved: EventV2.ID.make("evt_checkpoint_project_a_saved"),
  projectAInitialized: EventV2.ID.make("evt_checkpoint_project_a_initialized"),
  projectBSaved: EventV2.ID.make("evt_checkpoint_project_b_saved"),
  sessionACreated: EventV2.ID.make("evt_checkpoint_session_a_created"),
  sessionAMessage: EventV2.ID.make("evt_checkpoint_session_a_message"),
  sessionAPart: EventV2.ID.make("evt_checkpoint_session_a_part"),
  sessionBCreated: EventV2.ID.make("evt_checkpoint_session_b_created"),
  deleted: EventV2.ID.make("evt_checkpoint_deleted"),
}

const layers = (filename: string) =>
  Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provideMerge(Database.layerFromPath(filename)),
  )

describe("native database checkpoint inspector", () => {
  test(
    "inspects a real restored archive with multiple aggregates and unjournaled legacy rows",
    async () => {
      await using temp = await tmpdir()
      const fixture = await restoredFixture(temp.path, "success")
      const before = await readFile(fixture.source)
      const inventory = await inspect(fixture)
      const again = await inspect(fixture)

      expect(again).toEqual(inventory)
      expect(await readFile(fixture.source)).toEqual(before)
      expect(await sidecars(fixture.source)).toEqual([])
      expect(inventory.database).toEqual({
        bytes: fixture.expected.bytes,
        sha256: fixture.expected.sha256,
        schemaSha256: fixture.expected.schemaSha256,
      })
      expect(inventory.projects).toEqual([
        { id: projectA, journaled: true },
        { id: projectB, journaled: true },
        { id: projectLegacy, journaled: false },
      ])
      expect(inventory.sessions).toEqual([
        { id: sessionA, projectID: projectA, journaled: true },
        { id: sessionB, projectID: projectB, journaled: true },
        { id: sessionLegacy, projectID: projectLegacy, journaled: false },
      ])
      expect(inventory.tombstonesRecorded).toBe(true)
      expect(inventory.tombstones).toEqual([{ aggregateID: sessionDeleted, id: eventIDs.deleted, seq: 3 }])
      expect(inventory.counts).toEqual({ events: 7, tombstones: 1 })
      expect(aggregateShape(inventory)).toEqual({
        [projectA]: { seq: 1, events: 2 },
        [projectB]: { seq: 0, events: 1 },
        [sessionA]: { seq: 2, events: 3 },
        [sessionB]: { seq: 0, events: 1 },
      })
      expect(inventory.aggregates.every((aggregate) => /^[0-9a-f]{64}$/.test(aggregate.sha256))).toBe(true)

      const serialized = JSON.stringify(inventory)
      expect(serialized).not.toContain(marker)
      expect(serialized).not.toContain(ownerMarker)
      expect(serialized).not.toContain("/checkpoint/")
      expect(serialized).not.toContain(temp.path)
    },
    ioTimeout,
  )

  test(
    "is deterministic, read-only and does not create migration or SQLite sidecar artifacts",
    async () => {
      await using temp = await tmpdir()
      const fixture = await restoredFixture(temp.path, "readonly")
      const beforeFiles = (await readdir(temp.path)).sort()
      const beforeBytes = await readFile(fixture.source)
      const inventory = await inspect(fixture)

      expect(await inspect(fixture)).toEqual(inventory)
      expect(inventory.tombstonesRecorded).toBe(true)

      expect(await readFile(fixture.source)).toEqual(beforeBytes)
      expect((await readdir(temp.path)).sort()).toEqual(beforeFiles)
      expect((await readdir(temp.path)).some((name) => name.startsWith(".mongolgpt-backup-"))).toBe(false)
      expect(await sidecars(fixture.source)).toEqual([])
    },
    ioTimeout,
  )

  test(
    "supports legacy restored images without a tombstone table without mutating schema or files",
    async () => {
      await using temp = await tmpdir()
      const source = join(temp.path, "legacy-absent-tombstone-source.sqlite")
      await seed(source)
      const native = await import("bun:sqlite")
      const db = new native.Database(source)
      db.run("DROP TABLE cloud_history_tombstone")
      db.close()
      const fixture = await archiveRestore(temp.path, "legacy-absent-tombstone", source)
      const beforeBytes = await readFile(fixture.source)
      const beforeTables = await tableEntries(fixture.source)
      const inventory = await inspect(fixture)

      expect(inventory.tombstonesRecorded).toBe(false)
      expect(inventory.tombstones).toEqual([])
      expect(inventory.counts).toEqual({ events: 7, tombstones: 0 })
      expect(aggregateShape(inventory)).toEqual({
        [projectA]: { seq: 1, events: 2 },
        [projectB]: { seq: 0, events: 1 },
        [sessionA]: { seq: 2, events: 3 },
        [sessionB]: { seq: 0, events: 1 },
      })
      expect(await readFile(fixture.source)).toEqual(beforeBytes)
      expect(await tableEntries(fixture.source)).toEqual(beforeTables)
      expect(await sidecars(fixture.source)).toEqual([])
    },
    ioTimeout,
  )

  test(
    "paginates more than 128 events across aggregate boundaries without dropping metadata",
    async () => {
      await using temp = await tmpdir()
      const fixture = await restoredPagedFixture(temp.path)
      const inventory = await inspect(fixture)

      expect(await inspect(fixture)).toEqual(inventory)
      expect(inventory.tombstonesRecorded).toBe(true)
      expect(inventory.counts).toEqual({ events: 131, tombstones: 0 })
      expect(inventory.aggregates.reduce((sum, aggregate) => sum + aggregate.events, 0)).toBe(131)
      expect(aggregateShape(inventory)).toEqual({
        [projectA]: { seq: 0, events: 1 },
        [projectB]: { seq: 0, events: 1 },
        [sessionA]: { seq: 126, events: 127 },
        [sessionB]: { seq: 1, events: 2 },
      })
      expect(inventory.aggregates.every((aggregate) => /^[0-9a-f]{64}$/.test(aggregate.sha256))).toBe(true)
      expect(await sidecars(fixture.source)).toEqual([])
    },
    ioTimeout,
  )

  test(
    "binds aggregate hashes to event content for otherwise identical valid snapshots",
    async () => {
      await using temp = await tmpdir()
      const first = await restoredFixture(temp.path, "hash-a", { partText: "first checkpoint content" })
      const second = await restoredFixture(temp.path, "hash-b", { partText: "second checkpoint content" })
      const firstInventory = await inspect(first)
      const secondInventory = await inspect(second)
      const firstSession = firstInventory.aggregates.find((aggregate) => aggregate.id === sessionA)
      const secondSession = secondInventory.aggregates.find((aggregate) => aggregate.id === sessionA)

      expect(aggregateShape(firstInventory)).toEqual(aggregateShape(secondInventory))
      expect(firstSession?.seq).toBe(2)
      expect(secondSession?.seq).toBe(2)
      expect(firstSession?.events).toBe(3)
      expect(secondSession?.events).toBe(3)
      expect(firstSession?.sha256).not.toBe(secondSession?.sha256)
    },
    ioTimeout,
  )

  test(
    "rejects restored images with a modified authenticated report",
    async () => {
      await using temp = await tmpdir()
      const fixture = await restoredFixture(temp.path, "report")

      await expectCheckpointFailure({
        source: fixture.source,
        expected: { ...fixture.expected, sha256: createHash("sha256").update("modified").digest("hex") },
      })
    },
    ioTimeout,
  )

  test(
    "rejects a valid SQLite image changed after its authenticated restore",
    async () => {
      await using temp = await tmpdir()
      const fixture = await restoredFixture(temp.path, "changed-image")
      const native = await import("bun:sqlite")
      const db = new native.Database(fixture.source)
      try {
        db.query("UPDATE event SET data = json_set(data, '$.part.text', ?) WHERE id = ?").run(
          "changed after restore",
          eventIDs.sessionAPart,
        )
      } finally {
        db.close()
      }
      const changed = await readFile(fixture.source)
      await expectCheckpointFailure(fixture)
      expect(await readFile(fixture.source)).toEqual(changed)
      expect(await sidecars(fixture.source)).toEqual([])
    },
    ioTimeout,
  )

  test(
    "rejects an oversized event before materializing a page of payloads",
    async () => {
      await using temp = await tmpdir()
      const fixture = await restoredFixture(temp.path, "oversized", { partText: "x".repeat(1024 * 1024 + 1) })
      await expectCheckpointFailure(fixture)
    },
    ioTimeout,
  )

  test(
    "rejects missing current checkpoint tables",
    async () => {
      await using temp = await tmpdir()
      const source = join(temp.path, "missing-schema.sqlite")
      const native = await import("bun:sqlite")
      const db = new native.Database(source)
      db.run("CREATE TABLE unrelated (id TEXT PRIMARY KEY)")
      db.run("INSERT INTO unrelated VALUES ('row')")
      db.close()

      await expectCheckpointFailure(await archiveRestore(temp.path, "missing-schema", source))
    },
    ioTimeout,
  )

  test(
    "rejects views impersonating required or optional checkpoint tables",
    async () => {
      await using temp = await tmpdir()

      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "required-view", (db) => {
          db.run("PRAGMA foreign_keys = OFF")
          db.run("DROP TABLE event")
          db.run("CREATE VIEW event AS SELECT 'evt_view' AS id")
        }),
      )
      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "optional-view", (db) => {
          db.run("DROP TABLE cloud_history_tombstone")
          db.run("CREATE VIEW cloud_history_tombstone AS SELECT 'ses_deleted' AS aggregate_id")
        }),
      )
    },
    ioTimeout,
  )

  test(
    "rejects event sequence gaps",
    async () => {
      await using temp = await tmpdir()

      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "gap", (db) => {
          db.query("DELETE FROM event WHERE aggregate_id = ? AND seq = 1").run(sessionA)
        }),
      )
    },
    ioTimeout,
  )

  test(
    "rejects event sequence heads that do not match the exact event tail",
    async () => {
      await using temp = await tmpdir()

      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "head", (db) => {
          db.query("UPDATE event_sequence SET seq = 1 WHERE aggregate_id = ?").run(sessionA)
        }),
      )
    },
    ioTimeout,
  )

  test(
    "rejects unknown durable event types",
    async () => {
      await using temp = await tmpdir()

      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "unknown-type", (db) => {
          db.query("UPDATE event SET type = 'session.unknown.1' WHERE id = ?").run(eventIDs.sessionACreated)
        }),
      )
    },
    ioTimeout,
  )

  test(
    "rejects invalid durable event data",
    async () => {
      await using temp = await tmpdir()

      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "invalid-data", (db) => {
          db.query("UPDATE event SET data = ? WHERE id = ?").run(
            JSON.stringify({ sessionID: sessionA, info: { id: sessionA } }),
            eventIDs.sessionACreated,
          )
        }),
      )
    },
    ioTimeout,
  )

  test(
    "rejects durable aggregate mapping mismatches",
    async () => {
      await using temp = await tmpdir()

      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "aggregate-mismatch", (db) => {
          db.query("UPDATE event SET data = ? WHERE id = ?").run(
            JSON.stringify({ sessionID: sessionB, info: sessionInfo(sessionA, projectA, "a") }),
            eventIDs.sessionACreated,
          )
        }),
      )
    },
    ioTimeout,
  )

  test(
    "rejects event sequences for missing project or session scopes",
    async () => {
      await using temp = await tmpdir()

      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "missing-scope", (db) => {
          db.run("INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES ('ses_checkpoint_orphan', 0, NULL)")
        }),
      )
    },
    ioTimeout,
  )

  test(
    "rejects invalid tombstones and live tombstone collisions",
    async () => {
      await using temp = await tmpdir()

      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "live-tombstone-aggregate", (db) => {
          db.query("INSERT INTO cloud_history_tombstone (aggregate_id, event_id, seq) VALUES (?, ?, 2)").run(
            sessionA,
            EventV2.ID.make("evt_checkpoint_live_tombstone"),
          )
        }),
      )
      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "live-tombstone-event", (db) => {
          db.query("INSERT INTO cloud_history_tombstone (aggregate_id, event_id, seq) VALUES (?, ?, 2)").run(
            Session.ID.descending("ses_checkpoint_deleted_event_collision"),
            eventIDs.sessionACreated,
          )
        }),
      )
    },
    ioTimeout,
  )

  test(
    "rejects negative tombstone sequences in an otherwise valid archive",
    async () => {
      await using temp = await tmpdir()
      await expectCheckpointFailure(
        await corruptedFixture(temp.path, "negative-tombstone", (db) => {
          db.run("UPDATE cloud_history_tombstone SET seq = -1")
        }),
      )
    },
    ioTimeout,
  )

  test(
    "rejects restored images with SQLite sidecars",
    async () => {
      await using temp = await tmpdir()
      const fixture = await restoredFixture(temp.path, "sidecar")

      await writeFile(fixture.source + "-wal", "sidecar")

      await expectCheckpointFailure(fixture)
    },
    ioTimeout,
  )

  test.skipIf(process.platform === "win32")(
    "rejects source symlinks",
    async () => {
      await using temp = await tmpdir()
      const fixture = await restoredFixture(temp.path, "symlink")
      const link = join(temp.path, "restored-link.sqlite")

      await symlink(fixture.source, link)

      await expectCheckpointFailure({ source: link, expected: fixture.expected })
    },
    ioTimeout,
  )
})

async function seed(filename: string, input: { partText?: string } = {}) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service

      yield* events.publish(
        ProjectHistory.Changed,
        {
          projectID: projectA,
          change: {
            type: "saved",
            info: {
              id: projectA,
              worktree: `/checkpoint/${marker}/a`,
              name: "Checkpoint A",
              time: { created: 1000, updated: 1001 },
              sandboxes: [],
            },
          },
        },
        { id: eventIDs.projectASaved },
      )
      yield* events.publish(
        ProjectHistory.Changed,
        { projectID: projectA, change: { type: "initialized", time: 1002 } },
        { id: eventIDs.projectAInitialized },
      )
      yield* events.publish(
        ProjectHistory.Changed,
        {
          projectID: projectB,
          change: {
            type: "saved",
            info: {
              id: projectB,
              worktree: "/checkpoint/b",
              name: "Checkpoint B",
              time: { created: 1100, updated: 1101 },
              sandboxes: [],
            },
          },
        },
        { id: eventIDs.projectBSaved },
      )
      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: sessionA, info: sessionInfo(sessionA, projectA, "a") },
        { id: eventIDs.sessionACreated },
      )
      yield* events.publish(
        SessionV1.Event.MessageUpdated,
        {
          sessionID: sessionA,
          info: Schema.decodeUnknownSync(SessionV1.Info)({
            id: "msg_checkpoint_a",
            sessionID: sessionA,
            role: "user",
            time: { created: 2100 },
            agent: "build",
            model: { providerID: "opencode", modelID: "checkpoint-model" },
            system: marker,
          }),
        },
        { id: eventIDs.sessionAMessage },
      )
      yield* events.publish(
        SessionV1.Event.PartUpdated,
        {
          sessionID: sessionA,
          time: 2101,
          part: Schema.decodeUnknownSync(SessionV1.Part)({
            id: "prt_checkpoint_a",
            sessionID: sessionA,
            messageID: "msg_checkpoint_a",
            type: "text",
            text: input.partText ?? marker,
          }),
        },
        { id: eventIDs.sessionAPart },
      )
      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: sessionB, info: sessionInfo(sessionB, projectB, "b") },
        { id: eventIDs.sessionBCreated },
      )
      yield* database.db.run(sql`UPDATE event_sequence SET owner_id = ${ownerMarker} WHERE aggregate_id = ${sessionA}`)
      yield* database.db.run(sql`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes, name)
        VALUES (${projectLegacy}, ${`/checkpoint/${marker}/legacy`}, 3000, 3001, '[]', 'Legacy Checkpoint')
      `)
      yield* database.db.run(sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (${sessionLegacy}, ${projectLegacy}, 'legacy', ${`/checkpoint/${marker}/legacy`}, 'Legacy Session', 'test', 3100, 3101)
      `)
      yield* database.db.run(sql`
        INSERT INTO cloud_history_tombstone (aggregate_id, event_id, seq)
        VALUES (${sessionDeleted}, ${eventIDs.deleted}, 3)
      `)
    }).pipe(Effect.provide(layers(filename)), Effect.scoped),
  )
}

async function seedPaged(filename: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service

      yield* events.publish(
        ProjectHistory.Changed,
        {
          projectID: projectA,
          change: {
            type: "saved",
            info: {
              id: projectA,
              worktree: "/checkpoint/paged-a",
              name: "Paged A",
              time: { created: 1000, updated: 1001 },
              sandboxes: [],
            },
          },
        },
        { id: EventV2.ID.make("evt_checkpoint_paged_project_a") },
      )
      yield* events.publish(
        ProjectHistory.Changed,
        {
          projectID: projectB,
          change: {
            type: "saved",
            info: {
              id: projectB,
              worktree: "/checkpoint/paged-b",
              name: "Paged B",
              time: { created: 1100, updated: 1101 },
              sandboxes: [],
            },
          },
        },
        { id: EventV2.ID.make("evt_checkpoint_paged_project_b") },
      )
      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: sessionA, info: sessionInfo(sessionA, projectA, "paged-a") },
        { id: EventV2.ID.make("evt_checkpoint_paged_session_a_created") },
      )
      yield* Effect.forEach(
        Array.from({ length: 126 }, (_, index) => index),
        (index) =>
          events.publish(
            SessionV1.Event.MessageUpdated,
            {
              sessionID: sessionA,
              info: Schema.decodeUnknownSync(SessionV1.Info)({
                id: `msg_checkpoint_paged_a_${index.toString().padStart(3, "0")}`,
                sessionID: sessionA,
                role: "user",
                time: { created: 2000 + index },
                agent: "build",
                model: { providerID: "opencode", modelID: "checkpoint-model" },
              }),
            },
            { id: EventV2.ID.make(`evt_checkpoint_paged_a_${index.toString().padStart(3, "0")}`) },
          ),
        { discard: true },
      )
      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: sessionB, info: sessionInfo(sessionB, projectB, "paged-b") },
        { id: EventV2.ID.make("evt_checkpoint_paged_session_b_created") },
      )
      yield* events.publish(
        SessionV1.Event.MessageUpdated,
        {
          sessionID: sessionB,
          info: Schema.decodeUnknownSync(SessionV1.Info)({
            id: "msg_checkpoint_paged_b",
            sessionID: sessionB,
            role: "user",
            time: { created: 3000 },
            agent: "build",
            model: { providerID: "opencode", modelID: "checkpoint-model" },
          }),
        },
        { id: EventV2.ID.make("evt_checkpoint_paged_b") },
      )
    }).pipe(Effect.provide(layers(filename)), Effect.scoped),
  )
}

function sessionInfo(sessionID: Session.ID, projectID: Project.ID, suffix: string) {
  return Schema.decodeUnknownSync(SessionV1.SessionInfo)({
    id: sessionID,
    projectID,
    directory: `/checkpoint/${suffix}`,
    slug: suffix,
    title: `Session ${suffix}`,
    version: "test",
    time: { created: 2000, updated: 2001 },
  })
}

async function restoredFixture(directory: string, name: string, input?: { partText?: string }) {
  const source = join(directory, `${name}-source.sqlite`)
  await seed(source, input)
  return archiveRestore(directory, name, source)
}

async function restoredPagedFixture(directory: string) {
  const source = join(directory, "paged-source.sqlite")
  await seedPaged(source)
  return archiveRestore(directory, "paged", source)
}

async function corruptedFixture(
  directory: string,
  name: string,
  mutate: (db: InstanceType<(typeof import("bun:sqlite"))["Database"]>) => void,
) {
  const valid = await restoredFixture(directory, `${name}-valid`)
  const source = join(directory, `${name}-source.sqlite`)
  await copyFile(valid.source, source)
  const native = await import("bun:sqlite")
  const db = new native.Database(source)
  try {
    db.run("PRAGMA foreign_keys = ON")
    mutate(db)
  } finally {
    db.close()
  }
  return archiveRestore(directory, name, source)
}

async function archiveRestore(directory: string, name: string, source: string) {
  const archive = join(directory, `${name}.backup`)
  const restored = join(directory, `${name}-restored.sqlite`)
  const key = randomBytes(32)
  const expected = await Effect.runPromise(DatabaseBackup.create({ source, destination: archive, key }))
  expect(await Effect.runPromise(DatabaseBackup.restore({ source: archive, destination: restored, key }))).toEqual(
    expected,
  )
  return { source: restored, expected }
}

async function inspect(fixture: { source: string; expected: DatabaseBackup.Report }) {
  return Effect.runPromise(DatabaseCheckpoint.inspect(fixture))
}

async function expectCheckpointFailure(fixture: { source: string; expected: DatabaseBackup.Report }) {
  const error = await Effect.runPromise(Effect.flip(DatabaseCheckpoint.inspect(fixture)))
  expect(error.message).toBe(genericError)
  expect(JSON.stringify(error)).not.toContain(marker)
  expect(JSON.stringify(error)).not.toContain(ownerMarker)
  expect(JSON.stringify(error)).not.toContain(fixture.source)
}

function aggregateShape(inventory: DatabaseCheckpoint.Inventory) {
  return Object.fromEntries(
    inventory.aggregates.map((aggregate) => [aggregate.id, { seq: aggregate.seq, events: aggregate.events }]),
  )
}

async function sidecars(filename: string) {
  const entries = await readdir(dirname(filename))
  return entries.filter((entry) =>
    [`${basename(filename)}-wal`, `${basename(filename)}-shm`, `${basename(filename)}-journal`].includes(entry),
  )
}

async function tableEntries(filename: string) {
  const native = await import("bun:sqlite")
  const db = new native.Database(filename, { readonly: true })
  try {
    return db
      .query<
        { name: string; type: string },
        []
      >("SELECT name, type FROM sqlite_schema WHERE name IN ('project', 'session', 'event', 'event_sequence', 'cloud_history_tombstone') ORDER BY name")
      .all()
  } finally {
    db.close()
  }
}
