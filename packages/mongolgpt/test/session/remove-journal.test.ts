import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { EventSequenceTable, EventTable } from "@mongolgpt/core/event/sql"
import { ProjectTable } from "@mongolgpt/core/project/sql"
import { ProjectSchema } from "@mongolgpt/core/project/schema"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { MessageTable, PartTable, SessionTable } from "@mongolgpt/core/session/sql"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { BackgroundJob } from "@/background/job"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const deletedType = EventV2.versionedType(SessionV1.Event.Deleted.type, SessionV1.Event.Deleted.durable!.version)
const ids = ["ses_remove_root", "ses_remove_child", "ses_remove_grandchild"].map((id) => SessionID.make(id))

function services(append: (event: EventV2.SerializedEvent) => Effect.Effect<void>) {
  return Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(BackgroundJob.layer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
    ),
    SessionProjector.layer,
  ).pipe(Layer.provideMerge(EventV2Bridge.layer.pipe(Layer.provideMerge(EventV2.layerWith({ journal: { append } })))))
}

const seed = Effect.fnUntraced(function* (count: number) {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  // Seed only the project FK; session, message and part rows are created by the real projectors.
  yield* database.db
    .insert(ProjectTable)
    .values({ id: ProjectSchema.ID.make("global"), worktree: AbsolutePath.make("/workspace"), sandboxes: [] })
    .run()
  for (const [index, sessionID] of ids.slice(0, count).entries()) {
    yield* events.publish(SessionV1.Event.Created, {
      sessionID,
      info: Schema.decodeUnknownSync(SessionV1.SessionInfo)({
        id: sessionID,
        ...(index > 0 ? { parentID: ids[index - 1] } : {}),
        slug: `remove-${index}`,
        projectID: "global",
        directory: "/workspace",
        title: `Session ${index}`,
        version: "test",
        time: { created: 1000, updated: 1000 },
      }),
    })
    yield* events.publish(SessionV1.Event.MessageUpdated, {
      sessionID,
      info: Schema.decodeUnknownSync(SessionV1.Info)({
        id: `msg_remove_${index}`,
        sessionID,
        role: "user",
        time: { created: 1001 },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
      }),
    })
    yield* events.publish(SessionV1.Event.PartUpdated, {
      sessionID,
      time: 1002,
      part: Schema.decodeUnknownSync(SessionV1.Part)({
        id: `prt_remove_${index}`,
        messageID: `msg_remove_${index}`,
        sessionID,
        type: "text",
        text: `Retained content ${index}`,
      }),
    })
  }
})

const snapshot = Effect.gen(function* () {
  const database = yield* Database.Service
  return {
    sessions: yield* database.db.select().from(SessionTable).all(),
    messages: yield* database.db.select().from(MessageTable).all(),
    parts: yield* database.db.select().from(PartTable).all(),
    events: yield* database.db.select().from(EventTable).all(),
    sequences: yield* database.db.select().from(EventSequenceTable).all(),
  }
})

describe("Session.remove remote journal boundary", () => {
  it.effect("does not acknowledge or notify a deletion whose remote commit fails", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const receipt = yield* Deferred.make<void>()
      const acknowledged = yield* Deferred.make<void>()
      const attempted: EventV2.SerializedEvent[] = []
      const observed: EventV2.Payload[] = []
      yield* Effect.gen(function* () {
        const session = yield* Session.Service
        const events = yield* EventV2.Service
        expect(yield* InstanceRef).toBeUndefined()
        yield* seed(1)
        const before = yield* snapshot
        yield* events.listen((event) =>
          Effect.sync(() => {
            observed.push(event)
          }),
        )
        // Yielded journal failures must escape Session.remove's JavaScript catch.
        const removing = yield* session.remove(ids[0]).pipe(
          Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
          Effect.exit,
          Effect.forkScoped,
        )
        yield* Deferred.await(entered)
        expect(yield* Deferred.isDone(acknowledged)).toBe(false)
        expect(observed).toEqual([])
        expect(attempted).toHaveLength(1)
        expect(attempted[0]).toMatchObject({ type: deletedType, aggregateID: ids[0], seq: 3 })
        yield* Deferred.succeed(receipt, undefined)
        const result = yield* Fiber.join(removing)
        expect(Exit.isFailure(result)).toBe(true)
        expect(String(result)).not.toContain("private remote failure")
        expect(yield* Deferred.isDone(acknowledged)).toBe(false)
        expect(observed).toEqual([])
        expect(yield* snapshot).toEqual(before)
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* session.remove(ids[0]).pipe(Effect.exit))).toBe(true)
        expect(attempted).toHaveLength(1)
        expect(yield* snapshot).toEqual(before)
      }).pipe(
        Effect.provide(
          services((event) => {
            if (event.type !== deletedType) return Effect.void
            return Effect.gen(function* () {
              attempted.push(event)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(receipt)
              return yield* Effect.die(new Error("private remote failure"))
            })
          }),
        ),
      )
    }),
  )

  it.effect("propagates a recursive child's journal failure without deleting or acknowledging its ancestors", () =>
    Effect.gen(function* () {
      const attempted: EventV2.SerializedEvent[] = []
      const observed: EventV2.Payload[] = []
      yield* Effect.gen(function* () {
        const session = yield* Session.Service
        const events = yield* EventV2.Service
        yield* seed(3)
        const before = yield* snapshot
        yield* events.listen((event) =>
          Effect.sync(() => {
            observed.push(event)
          }),
        )
        const result = yield* session.remove(ids[0]).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(observed).toEqual([])
        expect(attempted.map((event) => event.aggregateID)).toEqual([ids[2]])
        expect(yield* snapshot).toEqual(before)
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* session.remove(ids[1]).pipe(Effect.exit))).toBe(true)
        expect(attempted).toHaveLength(1)
      }).pipe(
        Effect.provide(
          services((event) => {
            if (event.type !== deletedType) return Effect.void
            return Effect.sync(() => {
              attempted.push(event)
              throw new Error("private remote failure")
            })
          }),
        ),
      )
    }),
  )

  for (const poisoned of [0, 1]) {
    it.effect(
      `rejects a schema-poisoned ${poisoned === 0 ? "root" : "child"} without acknowledging or appending a delete`,
      () =>
        Effect.gen(function* () {
          const attempted: EventV2.SerializedEvent[] = []
          const observed: EventV2.Payload[] = []
          yield* Effect.gen(function* () {
            const database = yield* Database.Service
            const session = yield* Session.Service
            const events = yield* EventV2.Service
            yield* seed(poisoned + 1)
            yield* database.db
              .update(SessionTable)
              .set({ time_created: -1 })
              .where(eq(SessionTable.id, ids[poisoned]))
              .run()
            const before = yield* snapshot
            yield* events.listen((event) =>
              Effect.sync(() => {
                observed.push(event)
              }),
            )
            expect(Exit.isFailure(yield* session.remove(ids[0]).pipe(Effect.exit))).toBe(true)
            expect(attempted).toEqual([])
            expect(observed).toEqual([])
            expect(yield* snapshot).toEqual(before)
            yield* events.check
          }).pipe(
            Effect.provide(
              services((event) =>
                Effect.sync(() => {
                  if (event.type === deletedType) attempted.push(event)
                }),
              ),
            ),
          )
        }),
    )
  }

  it.effect("acknowledges recursive cleanup without InstanceState only after successful journal writes", () =>
    Effect.gen(function* () {
      const acknowledged: string[] = []
      const observed: string[] = []
      yield* Effect.gen(function* () {
        const session = yield* Session.Service
        const events = yield* EventV2.Service
        yield* seed(3)
        expect(yield* InstanceRef).toBeUndefined()
        yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type !== SessionV1.Event.Deleted.type) return
            expect(acknowledged).toContain(event.durable!.aggregateID)
            observed.push(event.durable!.aggregateID)
          }),
        )
        expect(Exit.isSuccess(yield* session.remove(ids[0]).pipe(Effect.exit))).toBe(true)
        expect(acknowledged).toEqual([ids[2], ids[1], ids[0]])
        expect(observed).toEqual(acknowledged)
        expect(yield* snapshot).toEqual({ sessions: [], messages: [], parts: [], events: [], sequences: [] })
        yield* events.check
      }).pipe(
        Effect.provide(
          services((event) =>
            Effect.sync(() => {
              if (event.type === deletedType) acknowledged.push(event.aggregateID)
            }),
          ),
        ),
      )
    }),
  )
})
