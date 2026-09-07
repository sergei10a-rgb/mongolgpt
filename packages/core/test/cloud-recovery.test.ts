import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { createCloudHistory } from "@mongolgpt/core/event/cloud-history"
import { createCloudRecovery } from "@mongolgpt/core/event/cloud-recovery"
import { CloudHistoryTombstoneTable } from "@mongolgpt/core/event/cloud-history.sql"
import { EventTable } from "@mongolgpt/core/event/sql"
import { ProjectHistory } from "@mongolgpt/core/project/history"
import { ProjectTable } from "@mongolgpt/core/project/sql"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { SessionTable, MessageTable, PartTable } from "@mongolgpt/core/session/sql"
import { Project } from "@mongolgpt/schema/project"
import { Session } from "@mongolgpt/schema/session"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const sessionID = Session.ID.make("ses_recover_a")
const messageID = SessionV1.MessageID.make("msg_recover_a")
const removal = { sessionID, messageID }
const layers = (options?: EventV2.LayerOptions) =>
  Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
    Layer.provideMerge(EventV2.layerWith(options)),
    Layer.provideMerge(Database.layerFromPath(":memory:")),
  )

const source = Effect.gen(function* () {
  const wire: EventV2.SerializedEvent[] = []
  yield* Effect.gen(function* () {
    const history = yield* ProjectHistory.Service
    const events = yield* EventV2.Service
    for (const suffix of ["a", "b", "c"]) {
      const projectID = Project.ID.make(`project_${suffix}`)
      const sessionID = Session.ID.make(`ses_recover_${suffix}`)
      yield* history.change(projectID, {
        type: "saved",
        info: {
          id: projectID,
          worktree: `/workspace/${suffix}`,
          name: suffix,
          sandboxes: [],
          time: { created: 1000, updated: 1000 },
        },
      })
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: Schema.decodeUnknownSync(SessionV1.SessionInfo)({
          id: sessionID,
          projectID,
          directory: `/workspace/${suffix}`,
          slug: suffix,
          title: `Session ${suffix}`,
          version: "test",
          time: { created: 1000, updated: 1000 },
        }),
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: Schema.decodeUnknownSync(SessionV1.Info)({
          id: `msg_recover_${suffix}`,
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
          id: `prt_recover_${suffix}`,
          sessionID,
          messageID: `msg_recover_${suffix}`,
          type: "text",
          text: `Retained ${suffix}`,
        }),
      })
    }
  }).pipe(
    Effect.provide(
      layers({
        journal: {
          append: (event) =>
            Effect.sync(() => {
              wire.push(event)
            }),
        },
      }),
    ),
  )
  return wire
})

type Entry =
  | { cursor: number; deleted: false; event: EventV2.SerializedEvent }
  | { cursor: number; deleted: true; aggregateID: string; id: EventV2.ID; seq: number }

function fixture(entries: Entry[], onRead?: (after: number) => Promise<void>) {
  const calls: string[] = []
  const reply = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    })
  const cloud = createCloudHistory({
    request: async (request) => {
      const route = new URL(request.url).pathname
      calls.push(route)
      if (route === "/v1/epoch") return reply({ epoch: 0 })
      if (route === "/v1/claim") {
        const body = (await request.json()) as { writerID: string }
        return reply({ epoch: 1, writerID: body.writerID })
      }
      if (route === "/v1/read") {
        const body = (await request.json()) as { after: number }
        await onRead?.(body.after)
        const remaining = entries.filter((entry) => entry.cursor > body.after)
        const page = remaining.slice(0, 10)
        return reply({ entries: page, cursor: page.at(-1)?.cursor ?? body.after, hasMore: remaining.length > 10 })
      }
      throw new Error("Recovery must not append")
    },
  })
  return { recovery: createCloudRecovery(cloud), calls }
}

const pageEntries = (wire: EventV2.SerializedEvent[]): Entry[] =>
  wire.map((event, index) => ({ cursor: index + 1, deleted: false, event }))

describe("native cloud startup recovery", () => {
  it.live("does not reuse readiness for a different native projection", () =>
    Effect.gen(function* () {
      const input = fixture([])
      yield* input.recovery.recover.pipe(Effect.provide(layers(input.recovery.eventOptions)))
      const calls = input.calls.length
      expect(
        Exit.isFailure(
          yield* input.recovery.recover.pipe(Effect.provide(layers(input.recovery.eventOptions)), Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* input.recovery.admission.pipe(Effect.exit))).toBe(true)
      expect(input.calls).toHaveLength(calls)
    }),
  )

  it.live("keeps admission closed after recovery is interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const input = fixture([], () =>
        Effect.runPromise(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
      )
      yield* Effect.gen(function* () {
        const running = yield* input.recovery.recover.pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(running)
        yield* Deferred.succeed(release, undefined)
        expect(Exit.isFailure(yield* input.recovery.recover.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* input.recovery.admission.pipe(Effect.exit))).toBe(true)
        expect(input.calls).toEqual(["/v1/epoch", "/v1/claim", "/v1/read"])
      }).pipe(Effect.provide(layers(input.recovery.eventOptions)))
    }),
  )

  it.live("keeps admission closed until every global cursor page is projected, sharing one recovery", () =>
    Effect.gen(function* () {
      const wire = yield* source
      const secondPage = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const input = fixture(pageEntries(wire), (after) =>
        after === 10
          ? Effect.runPromise(Deferred.succeed(secondPage, undefined).pipe(Effect.andThen(Deferred.await(release))))
          : Promise.resolve(),
      )
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const notifications: EventV2.Payload[] = []
        yield* events.listen((event) =>
          Effect.sync(() => {
            notifications.push(event)
          }),
        )
        expect(yield* db.select().from(SessionTable).all()).toEqual([])
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
        const first = yield* input.recovery.recover.pipe(Effect.forkScoped)
        yield* Deferred.await(secondPage)
        const second = yield* input.recovery.recover.pipe(Effect.forkScoped)
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* events.publish(SessionV1.Event.MessageRemoved, removal).pipe(Effect.exit))).toBe(
          true,
        )
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        yield* events.check
        expect(input.calls).toEqual(["/v1/epoch", "/v1/claim", "/v1/read", "/v1/read"])
        expect(notifications).toEqual([])
        expect(yield* db.select().from(ProjectTable).all()).toHaveLength(3)
        expect(yield* db.select().from(SessionTable).all()).toHaveLength(3)
        expect(yield* db.select().from(MessageTable).all()).toHaveLength(3)
        const parts = yield* db.select().from(PartTable).all()
        expect(parts.map((part) => part.data)).toEqual(
          ["a", "b", "c"].map((suffix) => ({ type: "text", text: `Retained ${suffix}` })),
        )
        expect(yield* db.select().from(EventTable).all()).toHaveLength(12)
      }).pipe(Effect.provide(layers(input.recovery.eventOptions)))
    }),
  )

  it.live("applies content-free deletion to offline data and prevents resurrection or reused deletion IDs", () =>
    Effect.gen(function* () {
      const wire = yield* source
      const retained = wire.filter((event) => event.aggregateID !== sessionID)
      const tombstone = {
        cursor: 13,
        deleted: true as const,
        aggregateID: sessionID,
        id: EventV2.ID.make("evt_deleted_a"),
        seq: 3,
      }
      const input = fixture([...pageEntries(retained), tombstone])
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        // Already-journalled offline data can be reconciled without inventing deleted event payloads.
        for (const event of wire) yield* events.replay(event)
        yield* input.recovery.recover
        yield* events.check
        expect(yield* db.select().from(SessionTable).all()).toHaveLength(2)
        expect(yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all()).toEqual([])
        expect(yield* db.select().from(PartTable).where(eq(PartTable.session_id, sessionID)).all()).toEqual([])
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toEqual([])
        expect(yield* db.select().from(CloudHistoryTombstoneTable).get()).toEqual({
          aggregate_id: sessionID,
          event_id: tombstone.id,
          seq: 3,
        })
        const created = wire.find((event) => event.aggregateID === sessionID)!
        expect(Exit.isFailure(yield* events.replay(created).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* events.publish(SessionV1.Event.MessageRemoved, removal).pipe(Effect.exit))).toBe(
          true,
        )
        yield* events.remove(sessionID)
        expect(Exit.isFailure(yield* events.replay(created).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(
            yield* events
              .publish(
                SessionV1.Event.MessageRemoved,
                {
                  sessionID: Session.ID.make("ses_recover_b"),
                  messageID,
                },
                { id: tombstone.id },
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(input.calls).not.toContain("/v1/append")
      }).pipe(Effect.provide(layers(input.recovery.eventOptions)))
    }),
  )

  it.live("does not overwrite or claim a writer for unexported legacy data", () =>
    Effect.gen(function* () {
      const input = fixture(pageEntries(yield* source))
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({
            id: Project.ID.make("project_a"),
            worktree: AbsolutePath.make("/legacy"),
            name: "Unexported",
            sandboxes: [],
          })
          .run()
        const before = yield* db.select().from(ProjectTable).all()
        expect(Exit.isFailure(yield* input.recovery.recover.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* input.recovery.recover.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* input.recovery.admission.pipe(Effect.exit))).toBe(true)
        expect(yield* db.select().from(ProjectTable).all()).toEqual(before)
        expect(input.calls).toEqual([])
      }).pipe(Effect.provide(layers(input.recovery.eventOptions)))
    }),
  )

  it.live("fails admission permanently after a late read failure without replay retries", () =>
    Effect.gen(function* () {
      const input = fixture(pageEntries(yield* source), (after) =>
        after === 10 ? Promise.reject(new Error("private failure")) : Promise.resolve(),
      )
      yield* Effect.gen(function* () {
        expect(Exit.isFailure(yield* input.recovery.recover.pipe(Effect.exit))).toBe(true)
        const calls = input.calls.length
        expect(Exit.isFailure(yield* input.recovery.recover.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* input.recovery.admission.pipe(Effect.exit))).toBe(true)
        expect(input.calls).toHaveLength(calls)
      }).pipe(Effect.provide(layers(input.recovery.eventOptions)))
    }),
  )

  it.live("preserves native local events missing from the remote journal and refuses readiness", () =>
    Effect.gen(function* () {
      const wire = yield* source
      const input = fixture([])
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        for (const event of wire) yield* events.replay(event)
        const before = yield* db.select().from(EventTable).all()
        expect(Exit.isFailure(yield* events.recover.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
        expect(yield* db.select().from(EventTable).all()).toEqual(before)
        expect(yield* db.select().from(SessionTable).all()).toHaveLength(3)
        expect(input.calls).toEqual(["/v1/epoch", "/v1/claim", "/v1/read"])
      }).pipe(Effect.provide(layers(input.recovery.eventOptions)))
    }),
  )

  it.live("refuses recovery without registered domain projectors", () =>
    Effect.gen(function* () {
      const input = fixture(pageEntries(yield* source))
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(Exit.isFailure(yield* input.recovery.recover.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* input.recovery.admission.pipe(Effect.exit))).toBe(true)
        expect(yield* db.select().from(EventTable).all()).toEqual([])
      }).pipe(
        Effect.provide(
          EventV2.layerWith(input.recovery.eventOptions).pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))),
        ),
      )
    }),
  )
})
