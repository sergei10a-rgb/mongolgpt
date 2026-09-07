import { describe, expect, test } from "bun:test"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { EventSequenceTable, EventTable } from "@mongolgpt/core/event/sql"
import { SessionEvent } from "@mongolgpt/schema/session-event"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { Session } from "@mongolgpt/schema/session"
import { SessionMessage } from "@mongolgpt/schema/session-message"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { MessageTable, PartTable, SessionTable } from "@mongolgpt/core/session/sql"
import { ProjectTable } from "@mongolgpt/core/project/sql"
import { ProjectSchema } from "@mongolgpt/core/project/schema"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.defaultLayer)
const definition = SessionV1.Event.MessageRemoved
const data = (sessionID: Session.ID) => ({ sessionID, messageID: SessionV1.MessageID.make("msg_journal") })

describe("EventV2 remote journal commit boundary", () => {
  it.effect("bounds a stalled remote write and fences the queued writer", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const envelopes: EventV2.SerializedEvent[] = []
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const first = yield* events.publish(definition, data(Session.ID.create())).pipe(Effect.exit, Effect.forkScoped)
        yield* Deferred.await(entered)
        const queued = yield* events.publish(definition, data(Session.ID.create())).pipe(Effect.exit, Effect.forkScoped)
        yield* Effect.yieldNow
        yield* adjust("15 seconds")
        expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
        expect(Exit.isFailure(yield* Fiber.join(queued))).toBe(true)
        expect(envelopes).toHaveLength(1)
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
      }).pipe(
        Effect.provide(
          EventV2.layerWith({
            journal: {
              append: (event) =>
                Effect.gen(function* () {
                  envelopes.push(event)
                  yield* Deferred.succeed(entered, undefined)
                  yield* Effect.never
                }),
            },
          }),
        ),
      )
    }),
  )

  it.effect("waits for the encoded remote receipt before notifying or acknowledging", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const receipt = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const envelopes: EventV2.SerializedEvent[] = []
      const observed: EventV2.Payload[] = []
      const sessionID = Session.ID.create()
      const { db } = yield* Database.Service
      const journal = {
        append: (event: EventV2.SerializedEvent) =>
          Effect.gen(function* () {
            envelopes.push(event)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(receipt)
          }),
      }
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.listen((event) =>
          Effect.sync(() => {
            observed.push(event)
          }),
        )
        const writing = yield* events.publish(definition, data(sessionID)).pipe(
          Effect.tap(() => Deferred.succeed(done, undefined)),
          Effect.forkScoped,
        )
        yield* Deferred.await(entered)
        expect(observed).toEqual([])
        expect(yield* Deferred.isDone(done)).toBe(false)
        expect(envelopes).toHaveLength(1)
        expect(envelopes[0]).toMatchObject({
          type: EventV2.versionedType(definition.type, 1),
          aggregateID: sessionID,
          seq: 0,
          data: data(sessionID),
        })
        yield* Deferred.succeed(receipt, undefined)
        const published = yield* Fiber.join(writing)
        expect(observed).toEqual([published])
        const row = yield* db.select().from(EventTable).where(eq(EventTable.id, published.id)).get()
        expect(row?.data).toEqual(data(sessionID))
        expect(row?.seq).toBe(0)
        yield* events.check
      }).pipe(Effect.provide(EventV2.layerWith({ journal })))
    }),
  )

  it.effect("rolls back and fences further work after an uncertain remote write", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.create()
      const { db } = yield* Database.Service
      const envelopes: EventV2.SerializedEvent[] = []
      const observed: EventV2.Payload[] = []
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.listen((event) =>
          Effect.sync(() => {
            observed.push(event)
          }),
        )
        const exit = yield* events.publish(definition, data(sessionID)).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(String(exit)).not.toContain("secret transport details")
        expect(observed).toEqual([])
        expect(envelopes).toHaveLength(1)
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toEqual([])
        expect(
          yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get(),
        ).toBeUndefined()
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* events.publish(definition, data(sessionID)).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* events.remove(sessionID).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(yield* events.durable({ aggregateID: sessionID }).pipe(Stream.runCollect, Effect.exit)),
        ).toBe(true)
        expect(envelopes).toHaveLength(1)
      }).pipe(
        Effect.provide(
          EventV2.layerWith({
            journal: {
              append: (event) =>
                Effect.sync(() => {
                  envelopes.push(event)
                  throw new Error("secret transport details")
                }),
            },
          }),
        ),
      )
      // A fresh projection can replay the remote write whose response was lost, without re-appending it.
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.replay(envelopes[0]!)
        yield* events.replay(envelopes[0]!)
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toHaveLength(1)
      }).pipe(Effect.provide(EventV2.layerWith({ journal: { append: () => Effect.die("replay must not append") } })))
    }),
  )

  it.effect("validates projectors before writing remotely and does not fence validation errors", () =>
    Effect.gen(function* () {
      const envelopes: EventV2.SerializedEvent[] = []
      const sessionID = Session.ID.create()
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.project(definition, (event) =>
          event.data.sessionID === sessionID ? Effect.die("projector rejected") : Effect.void,
        )
        expect(Exit.isFailure(yield* events.publish(definition, data(sessionID)).pipe(Effect.exit))).toBe(true)
        expect(envelopes).toEqual([])
        yield* events.check
        yield* events.publish(definition, data(Session.ID.create()))
        expect(envelopes).toHaveLength(1)
      }).pipe(
        Effect.provide(
          EventV2.layerWith({
            journal: {
              append: (event) =>
                Effect.sync(() => {
                  envelopes.push(event)
                }),
            },
          }),
        ),
      )
    }),
  )

  it.effect("rejects unknown journal payload fields rather than silently dropping acknowledged data", () =>
    Effect.gen(function* () {
      const envelopes: EventV2.SerializedEvent[] = []
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const value = { ...data(Session.ID.create()), unknownField: "must not silently disappear" }
        expect(Exit.isFailure(yield* events.publish(definition, value).pipe(Effect.exit))).toBe(true)
        expect(envelopes).toEqual([])
        yield* events.check
      }).pipe(
        Effect.provide(
          EventV2.layerWith({
            journal: {
              append: (event) =>
                Effect.sync(() => {
                  envelopes.push(event)
                }),
            },
          }),
        ),
      )
    }),
  )

  it.effect("stores versioned wire data rather than Effect DateTime objects", () =>
    Effect.gen(function* () {
      const envelopes: EventV2.SerializedEvent[] = []
      const value = {
        sessionID: Session.ID.create(),
        timestamp: DateTime.makeUnsafe(1_717_171_717_000),
        messageID: SessionMessage.ID.make("msg_context"),
        text: "test context",
      }
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.publish(SessionEvent.ContextUpdated, value)
        expect(envelopes[0]?.data).toEqual(Schema.encodeSync(SessionEvent.ContextUpdated.data)(value))
        expect(envelopes[0]?.data.timestamp).toBe(1_717_171_717_000)
      }).pipe(
        Effect.provide(
          EventV2.layerWith({
            journal: {
              append: (event) =>
                Effect.sync(() => {
                  envelopes.push(event)
                }),
            },
          }),
        ),
      )
    }),
  )

  it.effect("rejects nested local transactions before remote acknowledgement", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const envelopes: EventV2.SerializedEvent[] = []
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const nested = yield* db
          .transaction(() => events.publish(definition, data(Session.ID.create())))
          .pipe(Effect.exit)
        expect(Exit.isFailure(nested)).toBe(true)
        expect(envelopes).toEqual([])
        yield* events.check
        yield* events.publish(definition, data(Session.ID.create()))
        expect(envelopes).toHaveLength(1)
      }).pipe(
        Effect.provide(
          EventV2.layerWith({
            journal: {
              append: (event) =>
                Effect.sync(() => {
                  envelopes.push(event)
                }),
            },
          }),
        ),
      )
    }),
  )

  it.effect("fences the projection when SQLite commit fails after a remote acknowledgement", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run("CREATE TEMP TABLE journal_parent (id TEXT PRIMARY KEY)")
      yield* db.run(
        "CREATE TEMP TABLE journal_child (id TEXT REFERENCES journal_parent(id) DEFERRABLE INITIALLY DEFERRED)",
      )
      const envelopes: EventV2.SerializedEvent[] = []
      const sessionID = Session.ID.create()
      const observed: EventV2.Payload[] = []
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.listen((event) =>
          Effect.sync(() => {
            observed.push(event)
          }),
        )
        const result = yield* events
          .publish(definition, data(sessionID), {
            commit: () =>
              db.run("INSERT INTO journal_child VALUES ('absent-parent')").pipe(Effect.orDie, Effect.asVoid),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(envelopes).toHaveLength(1)
        expect(observed).toEqual([])
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toEqual([])
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* events.publish(definition, data(Session.ID.create())).pipe(Effect.exit))).toBe(
          true,
        )
        expect(envelopes).toHaveLength(1)
      }).pipe(
        Effect.provide(
          EventV2.layerWith({
            journal: {
              append: (event) =>
                Effect.sync(() => {
                  envelopes.push(event)
                }),
            },
          }),
        ),
      )
    }),
  )

  test("rebuilds an empty SQLite session and message projection from acknowledged wire events", async () => {
    const envelopes: EventV2.SerializedEvent[] = []
    const journal = {
      append: (event: EventV2.SerializedEvent) =>
        Effect.sync(() => {
          envelopes.push(event)
        }),
    }
    const sessionID = Session.ID.create()
    const info = Schema.decodeUnknownSync(SessionV1.SessionInfo)({
      id: sessionID,
      slug: "journal-restart",
      projectID: "global",
      directory: "/workspace",
      title: "Restored chat",
      version: "test",
      time: { created: 1000, updated: 1000 },
    })
    const project = Effect.gen(function* () {
      const { db } = yield* Database.Service
      // The project bootstrap is explicit here; this does not simulate deployed startup wiring.
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectSchema.ID.make("global"), worktree: AbsolutePath.make("/workspace"), sandboxes: [] })
        .run()
    })
    const fresh = () =>
      SessionProjector.layer.pipe(
        Layer.provideMerge(EventV2.layerWith({ journal })),
        Layer.provideMerge(Database.layerFromPath(":memory:")),
      )
    await Effect.gen(function* () {
      yield* project
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, { sessionID, info })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: Schema.decodeUnknownSync(SessionV1.Info)({
          id: "msg_restore",
          sessionID,
          role: "user",
          time: { created: 1001 },
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        }),
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        time: 1002,
        part: Schema.decodeUnknownSync(SessionV1.Part)({
          id: "prt_restore",
          sessionID,
          messageID: "msg_restore",
          type: "text",
          text: "Durable user text",
        }),
      })
    }).pipe(Effect.provide(fresh()), Effect.scoped, Effect.runPromise)
    expect(envelopes).toHaveLength(3)
    await Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      expect(yield* db.select().from(SessionTable).all()).toEqual([])
      yield* project
      // Serialization/replay uses the same wire representation as the D1 RPC.
      const restored = JSON.parse(JSON.stringify(envelopes)) as EventV2.SerializedEvent[]
      yield* events.replayAll(restored)
      yield* events.replayAll(restored)
      expect((yield* db.select().from(SessionTable).get())?.title).toBe(info.title)
      expect((yield* db.select().from(MessageTable).get())?.data.role).toBe("user")
      expect((yield* db.select().from(PartTable).get())?.data).toMatchObject({
        type: "text",
        text: "Durable user text",
      })
      expect(yield* db.select().from(EventTable).all()).toHaveLength(3)
      expect(envelopes).toHaveLength(3)
    }).pipe(Effect.provide(fresh()), Effect.scoped, Effect.runPromise)
  })
})
