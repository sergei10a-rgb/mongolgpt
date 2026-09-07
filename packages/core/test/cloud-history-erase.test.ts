import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { eq, sql } from "drizzle-orm"
import path from "path"
import { Event } from "@mongolgpt/schema/event"
import { Project } from "@mongolgpt/schema/project"
import { Database } from "@mongolgpt/core/database/database"
import { CloudHistoryTombstoneTable } from "@mongolgpt/core/event/cloud-history.sql"
import { eraseCloudSession } from "@mongolgpt/core/event/cloud-history-erase"
import { EventSequenceTable, EventTable } from "@mongolgpt/core/event/sql"
import { ProjectTable } from "@mongolgpt/core/project/sql"
import { SessionV2 } from "@mongolgpt/core/session"
import {
  MessageTable,
  PartTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  TodoTable,
} from "@mongolgpt/core/session/sql"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { tmpdir } from "./fixture/tmpdir"

describe("cloud history deletion tombstones", () => {
  test("persists a terminal marker for an empty local projection", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "empty.sqlite")
    const sessionID = SessionV2.ID.make("ses_cloud_empty")
    const eventID = Event.ID.make("evt_cloud_empty_deleted")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* eraseCloudSession(db, { aggregateID: sessionID, id: eventID, seq: 0 })
        expect(yield* tombstone(db, sessionID)).toEqual({ aggregate_id: sessionID, event_id: eventID, seq: 0 })
        expect(yield* count(db, "session")).toBe(0)
        expect(yield* count(db, "event")).toBe(0)
        expect(yield* count(db, "event_sequence")).toBe(0)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("deletes populated legacy, modern and durable session state atomically", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "populated.sqlite")
    const sessionID = SessionV2.ID.make("ses_cloud_populated")
    const eventID = Event.ID.make("evt_cloud_populated_deleted")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* insertPopulatedSession(db, sessionID)
        yield* eraseCloudSession(db, { aggregateID: sessionID, id: eventID, seq: 3 })

        expect(yield* tombstone(db, sessionID)).toEqual({ aggregate_id: sessionID, event_id: eventID, seq: 3 })
        expect(yield* count(db, "session")).toBe(0)
        expect(yield* count(db, "message")).toBe(0)
        expect(yield* count(db, "part")).toBe(0)
        expect(yield* count(db, "todo")).toBe(0)
        expect(yield* count(db, "session_message")).toBe(0)
        expect(yield* count(db, "session_input")).toBe(0)
        expect(yield* count(db, "session_context_epoch")).toBe(0)
        expect(yield* count(db, "event")).toBe(0)
        expect(yield* count(db, "event_sequence")).toBe(0)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("accepts duplicate replay only when the marker exactly matches", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "replay.sqlite")
    const sessionID = SessionV2.ID.make("ses_cloud_replay")
    const eventID = Event.ID.make("evt_cloud_replay_deleted")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* eraseCloudSession(db, { aggregateID: sessionID, id: eventID, seq: 2 })
        yield* eraseCloudSession(db, { aggregateID: sessionID, id: eventID, seq: 2 })
        expect(yield* tombstone(db, sessionID)).toEqual({ aggregate_id: sessionID, event_id: eventID, seq: 2 })

        const changedID = yield* eraseCloudSession(db, {
          aggregateID: sessionID,
          id: Event.ID.make("evt_cloud_replay_changed"),
          seq: 2,
        }).pipe(Effect.exit)
        const changedSeq = yield* eraseCloudSession(db, { aggregateID: sessionID, id: eventID, seq: 3 }).pipe(
          Effect.exit,
        )

        expect(Exit.isFailure(changedID)).toBe(true)
        expect(Exit.isFailure(changedSeq)).toBe(true)
        expect(yield* tombstone(db, sessionID)).toEqual({ aggregate_id: sessionID, event_id: eventID, seq: 2 })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("rejects project ids, stale tombstones and reused event ids without deleting state", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "conflict.sqlite")
    const sessionID = SessionV2.ID.make("ses_cloud_conflict")
    const reusedEventID = Event.ID.make("evt_cloud_conflict_reused")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* insertPopulatedSession(db, sessionID)
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: "ses_other_reused", seq: 0 })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values({
            id: reusedEventID,
            aggregate_id: "ses_other_reused",
            seq: 0,
            type: "session.deleted.1",
            data: {},
          })
          .run()
          .pipe(Effect.orDie)

        const projectID = yield* eraseCloudSession(db, {
          aggregateID: Project.ID.global,
          id: Event.ID.make("evt_project_conflict"),
          seq: 0,
        }).pipe(Effect.exit)
        const stale = yield* eraseCloudSession(db, {
          aggregateID: sessionID,
          id: Event.ID.make("evt_cloud_conflict_stale"),
          seq: 0,
        }).pipe(Effect.exit)
        const reused = yield* eraseCloudSession(db, { aggregateID: sessionID, id: reusedEventID, seq: 3 }).pipe(
          Effect.exit,
        )

        expect(Exit.isFailure(projectID)).toBe(true)
        expect(Exit.isFailure(stale)).toBe(true)
        expect(Exit.isFailure(reused)).toBe(true)
        expect(yield* count(db, "session")).toBe(1)
        expect(yield* count(db, "event_sequence")).toBe(2)
        expect(yield* tombstone(db, sessionID)).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("rejects same-aggregate event id reuse unless it is the exact deletion row", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "same-aggregate-reuse.sqlite")
    const sessionID = SessionV2.ID.make("ses_cloud_same_reuse")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* insertPopulatedSession(db, sessionID)

        const reusedMessage = yield* eraseCloudSession(db, {
          aggregateID: sessionID,
          id: Event.ID.make("evt_cloud_populated_0"),
          seq: 2,
        }).pipe(Effect.exit)

        expect(Exit.isFailure(reusedMessage)).toBe(true)
        expect(yield* count(db, "session")).toBe(1)
        expect(yield* count(db, "event_sequence")).toBe(1)
        expect(yield* tombstone(db, sessionID)).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("rejects equal-head tombstones unless the stored head is the same deletion", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "equal-head-conflict.sqlite")
    const sessionID = SessionV2.ID.make("ses_cloud_equal_conflict")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* insertPopulatedSession(db, sessionID, 2, [
          {
            id: Event.ID.make("evt_cloud_equal_0"),
            aggregate_id: sessionID,
            seq: 0,
            type: "session.created.1",
            data: {},
          },
          {
            id: Event.ID.make("evt_cloud_equal_1"),
            aggregate_id: sessionID,
            seq: 1,
            type: "session.updated.1",
            data: {},
          },
          {
            id: Event.ID.make("evt_cloud_equal_2"),
            aggregate_id: sessionID,
            seq: 2,
            type: "session.updated.1",
            data: {},
          },
        ])

        const equalHead = yield* eraseCloudSession(db, {
          aggregateID: sessionID,
          id: Event.ID.make("evt_cloud_equal_deleted"),
          seq: 2,
        }).pipe(Effect.exit)

        expect(Exit.isFailure(equalHead)).toBe(true)
        expect(yield* count(db, "session")).toBe(1)
        expect(yield* count(db, "event")).toBe(3)
        expect(yield* tombstone(db, sessionID)).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("accepts exact locally applied session deletion replay at the current head", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "local-deletion-replay.sqlite")
    const sessionID = SessionV2.ID.make("ses_cloud_local_deleted")
    const eventID = Event.ID.make("evt_cloud_local_deleted")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* insertPopulatedSession(db, sessionID, 2, [
          {
            id: Event.ID.make("evt_cloud_local_0"),
            aggregate_id: sessionID,
            seq: 0,
            type: "session.created.1",
            data: {},
          },
          {
            id: Event.ID.make("evt_cloud_local_1"),
            aggregate_id: sessionID,
            seq: 1,
            type: "session.updated.1",
            data: {},
          },
          { id: eventID, aggregate_id: sessionID, seq: 2, type: "session.deleted.1", data: {} },
        ])

        yield* eraseCloudSession(db, { aggregateID: sessionID, id: eventID, seq: 2 })

        expect(yield* tombstone(db, sessionID)).toEqual({ aggregate_id: sessionID, event_id: eventID, seq: 2 })
        expect(yield* count(db, "session")).toBe(0)
        expect(yield* count(db, "event")).toBe(0)
        expect(yield* count(db, "event_sequence")).toBe(0)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("rolls back local deletion when marker persistence fails", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "rollback.sqlite")
    const sessionID = SessionV2.ID.make("ses_cloud_rollback")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* insertPopulatedSession(db, sessionID)
        yield* db.run(sql`
          CREATE TEMP TRIGGER cloud_history_tombstone_abort
          BEFORE INSERT ON cloud_history_tombstone
          BEGIN
            SELECT RAISE(ABORT, 'marker persistence failed');
          END;
        `)

        const failed = yield* eraseCloudSession(db, {
          aggregateID: sessionID,
          id: Event.ID.make("evt_cloud_rollback_deleted"),
          seq: 3,
        }).pipe(Effect.exit)

        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* count(db, "session")).toBe(1)
        expect(yield* count(db, "message")).toBe(1)
        expect(yield* count(db, "part")).toBe(1)
        expect(yield* count(db, "todo")).toBe(1)
        expect(yield* count(db, "session_message")).toBe(1)
        expect(yield* count(db, "session_input")).toBe(1)
        expect(yield* count(db, "session_context_epoch")).toBe(1)
        expect(yield* count(db, "event")).toBe(2)
        expect(yield* count(db, "event_sequence")).toBe(1)
        expect(yield* tombstone(db, sessionID)).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })
})

function insertPopulatedSession(
  db: Database.Interface["db"],
  sessionID: SessionV2.ID,
  latestSeq = 1,
  events: (typeof EventTable.$inferInsert)[] = [
    {
      id: Event.ID.make("evt_cloud_populated_0"),
      aggregate_id: sessionID,
      seq: 0,
      type: "session.created.1",
      data: {},
    },
    {
      id: Event.ID.make("evt_cloud_populated_1"),
      aggregate_id: sessionID,
      seq: 1,
      type: "session.updated.1",
      data: {},
    },
  ],
) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "cloud",
        directory: "/project",
        title: "Cloud",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db.run(sql`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES ('msg_cloud_legacy', ${sessionID}, 1, 1, '{"role":"user","time":{"created":1},"parts":[]}')
    `)
    yield* db.run(sql`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES ('part_cloud_legacy', 'msg_cloud_legacy', ${sessionID}, 1, 1, '{"type":"text","text":"hello"}')
    `)
    yield* db.run(sql`
      INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
      VALUES (${sessionID}, 'todo', 'pending', 'medium', 0, 1, 1)
    `)
    yield* db.run(sql`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES ('msg_cloud_modern', ${sessionID}, 'user', 0, 1, 1, '{"role":"user","content":[]}')
    `)
    yield* db.run(sql`
      INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
      VALUES ('msg_cloud_input', ${sessionID}, '{"text":"hi"}', 'queue', 1, NULL, 1)
    `)
    yield* db.run(sql`
      INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq)
      VALUES (${sessionID}, 'baseline', '{"sources":[]}', 0)
    `)
    yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: latestSeq }).run().pipe(Effect.orDie)
    yield* db.insert(EventTable).values(events).run().pipe(Effect.orDie)
  })
}

function tombstone(db: Database.Interface["db"], sessionID: string) {
  return db
    .select()
    .from(CloudHistoryTombstoneTable)
    .where(eq(CloudHistoryTombstoneTable.aggregate_id, sessionID))
    .get()
    .pipe(Effect.orDie)
}

function count(db: Database.Interface["db"], table: string) {
  return db.get(sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table)}`).pipe(
    Effect.orDie,
    Effect.map((row) => Number((row as { readonly count?: unknown } | undefined)?.count ?? 0)),
  )
}
