import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { EventTable } from "@mongolgpt/core/event/sql"
import { Location } from "@mongolgpt/core/location"
import { locationServiceMapLayer } from "@mongolgpt/core/location-services"
import { ModelV2 } from "@mongolgpt/core/model"
import { ProjectV2 } from "@mongolgpt/core/project"
import { ProjectTable } from "@mongolgpt/core/project/sql"
import { ProviderV2 } from "@mongolgpt/core/provider"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { SessionV2 } from "@mongolgpt/core/session"
import { SessionExecution } from "@mongolgpt/core/session/execution"
import { SessionEvent } from "@mongolgpt/core/session/event"
import { SessionMessage } from "@mongolgpt/core/session/message"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { SessionStore } from "@mongolgpt/core/session/store"
import { SessionMessageTable } from "@mongolgpt/core/session/sql"
import { SessionDurable } from "@mongolgpt/schema/durable-event-manifest"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

const layer = (journal: EventV2.SerializedEvent[]) => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layerWith({
    requireProjectors: true,
    journal: {
      append: (event) =>
        Effect.sync(() => {
          journal.push(event)
        }),
    },
  }).pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(locationServiceMapLayer),
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(
    database,
    events,
    projects,
    SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
    SessionStore.layer.pipe(Layer.provide(database)),
    SessionExecution.noopLayer,
    sessions,
  )
}

const makeIt = (journal: EventV2.SerializedEvent[]) => testEffect(layer(journal))
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = ModelV2.Ref.make({ id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") })
const timestamp = DateTime.makeUnsafe(1_717_171_717_000)
const later = DateTime.makeUnsafe(1_717_171_718_000)
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)

const projectedMessages = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
})

describe("Session progress durable history", () => {
  const journal: EventV2.SerializedEvent[] = []
  const it = makeIt(journal)

  it.effect("journals and replays retry and compaction start progress without changing the transcript", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const db = (yield* Database.Service).db
      const created = yield* sessions.create({ id: SessionV2.ID.make("ses_progress_history"), location, model })
      const assistantMessageID = SessionMessage.ID.make("msg_progress_assistant")
      const compactionMessageID = SessionMessage.ID.make("msg_progress_compaction")

      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: created.id,
        assistantMessageID,
        timestamp,
        agent: "build",
        model,
      })
      const beforeProgress = yield* projectedMessages
      const retried = yield* events.publish(SessionEvent.Retried, {
        sessionID: created.id,
        timestamp,
        attempt: 2,
        error: { message: "retryable outage", isRetryable: true, statusCode: 503 },
      })
      const compactionStarted = yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID: created.id,
        messageID: compactionMessageID,
        timestamp,
        reason: "manual",
      })

      expect(yield* projectedMessages).toEqual(beforeProgress)
      expect(retried.durable?.seq).toBe(2)
      expect(compactionStarted.durable?.seq).toBe(3)
      expect(
        journal.filter((event) =>
          [
            EventV2.versionedType(SessionEvent.Retried.type, 1),
            EventV2.versionedType(SessionEvent.Compaction.Started.type, 1),
          ].includes(event.type),
        ),
      ).toMatchObject([
        {
          aggregateID: created.id,
          seq: 2,
          type: EventV2.versionedType(SessionEvent.Retried.type, 1),
          data: { sessionID: created.id, timestamp: 1_717_171_717_000, attempt: 2 },
        },
        {
          aggregateID: created.id,
          seq: 3,
          type: EventV2.versionedType(SessionEvent.Compaction.Started.type, 1),
          data: { sessionID: created.id, timestamp: 1_717_171_717_000, messageID: compactionMessageID },
        },
      ])

      const history = yield* EventV2.readAggregate(db, {
        aggregateID: created.id,
        limit: 10,
        manifest: SessionDurable,
      })
      expect(history.events.map((event) => [event.durable?.seq, event.type])).toEqual([
        [1, SessionEvent.Step.Started.type],
        [2, SessionEvent.Retried.type],
        [3, SessionEvent.Compaction.Started.type],
      ])

      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID,
        timestamp: later,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID: created.id,
        messageID: compactionMessageID,
        timestamp: later,
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      expect((yield* projectedMessages).map((message) => message.type)).toEqual(["assistant", "compaction"])
      expect((yield* projectedMessages)[0]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: later },
      })
      expect((yield* projectedMessages)[1]).toMatchObject({
        type: "compaction",
        summary: "summary",
      })
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all()).toHaveLength(6)

      const targetJournal: EventV2.SerializedEvent[] = []
      yield* Effect.promise(() =>
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          const db = (yield* Database.Service).db
          const replay = (JSON.parse(JSON.stringify(journal)) as EventV2.SerializedEvent[]).filter(
            (event) => event.aggregateID === created.id,
          )
          const sourceID = created.id

          yield* db
            .insert(ProjectTable)
            .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          expect(yield* projectedMessages).toEqual([])
          expect(yield* events.replayAll(replay)).toBe(sourceID)
          expect(yield* events.replayAll(replay)).toBe(sourceID)
          expect(targetJournal).toEqual([])
          expect((yield* projectedMessages).map((message) => message.type)).toEqual(["assistant", "compaction"])
          expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sourceID)).all()).toHaveLength(6)

          const history = yield* EventV2.readAggregate(db, {
            aggregateID: sourceID,
            after: 1,
            limit: 2,
            manifest: SessionDurable,
          })
          expect(history.events.map((event) => [event.durable?.seq, event.type])).toEqual([
            [2, SessionEvent.Retried.type],
            [3, SessionEvent.Compaction.Started.type],
          ])
          expect(history.hasMore).toBe(true)

          expect(
            Exit.isFailure(
              yield* events
                .replay({
                  id: EventV2.ID.make("evt_unknown_progress"),
                  aggregateID: sourceID,
                  seq: 6,
                  type: "session.next.unknown.1",
                  data: { sessionID: sourceID },
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        }).pipe(Effect.provide(layer(targetJournal)), Effect.scoped, Effect.runPromise),
      )
    }),
  )
})
