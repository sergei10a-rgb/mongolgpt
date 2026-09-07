import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { createCloudHistory } from "@mongolgpt/core/event/cloud-history"
import { createCloudRecovery } from "@mongolgpt/core/event/cloud-recovery"
import { ProjectHistory } from "@mongolgpt/core/project/history"
import { ProjectTable } from "@mongolgpt/core/project/sql"
import { EventTable } from "@mongolgpt/core/event/sql"
import { Project } from "@mongolgpt/schema/project"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { Session } from "@mongolgpt/schema/session"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const projectID = Project.ID.make("project_lifecycle")
const payload = {
  sessionID: Session.ID.make("ses_lifecycle"),
  messageID: SessionV1.MessageID.make("msg_lifecycle"),
}
const configured = (config: Record<string, string | undefined>) =>
  EventV2.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
  )

describe("canonical native history lifecycle", () => {
  it.live("leaves both desktop and not-yet-migrated hosted processes local by default", () =>
    Effect.gen(function* () {
      for (const config of [{}, { MONGOLGPT_RUNTIME_MODE: "hosted" }, { MONGOLGPT_CLOUD_HISTORY: "false" }]) {
        yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          const { db } = yield* Database.Service
          yield* events.recover
          yield* events.publish(SessionV1.Event.MessageRemoved, payload)
          expect(yield* db.select().from(EventTable).all()).toHaveLength(1)
        }).pipe(Effect.provide(configured(config)))
      }
    }),
  )

  it.live("rejects invalid flags and cloud mode outside the trusted hosted runtime", () =>
    Effect.gen(function* () {
      for (const config of [
        { MONGOLGPT_CLOUD_HISTORY: "invalid" },
        { MONGOLGPT_CLOUD_HISTORY: "true" },
        { MONGOLGPT_CLOUD_HISTORY: "true", MONGOLGPT_RUNTIME_MODE: "local" },
      ]) {
        const result = yield* EventV2.Service.pipe(Effect.provide(configured(config)), Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }
    }),
  )

  it.live("closes admission as soon as the canonical cloud EventV2 is acquired", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* events.publish(SessionV1.Event.MessageRemoved, payload).pipe(Effect.exit))).toBe(
        true,
      )
      expect(yield* db.select().from(EventTable).all()).toEqual([])
    }).pipe(Effect.provide(configured({ MONGOLGPT_CLOUD_HISTORY: "true", MONGOLGPT_RUNTIME_MODE: "hosted" }))),
  )

  it.live("recovers the captured service and database, then permanently fences an uncertain append", () =>
    Effect.gen(function* () {
      const wire: EventV2.SerializedEvent[] = []
      yield* Effect.gen(function* () {
        const history = yield* ProjectHistory.Service
        yield* history.change(projectID, {
          type: "saved",
          info: {
            id: projectID,
            worktree: "/workspace/lifecycle",
            name: "Recovered project",
            sandboxes: [],
            time: { created: 100, updated: 200 },
          },
        })
      }).pipe(
        Effect.provide(
          ProjectHistory.layer.pipe(
            Layer.provide(
              EventV2.layerWith({
                journal: {
                  append: (event) =>
                    Effect.sync(() => {
                      wire.push(event)
                    }),
                },
              }),
            ),
            Layer.provide(Database.layerFromPath(":memory:")),
          ),
        ),
      )
      const calls: string[] = []
      const reply = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
      const recovery = createCloudRecovery(
        createCloudHistory({
          request: async (request) => {
            const route = new URL(request.url).pathname
            calls.push(route)
            if (route === "/v1/epoch") return reply({ epoch: 0 })
            if (route === "/v1/claim") {
              const body = (await request.json()) as { writerID: string }
              return reply({ epoch: 1, writerID: body.writerID })
            }
            if (route === "/v1/read")
              return reply({ entries: [{ cursor: 1, deleted: false, event: wire[0] }], cursor: 1, hasMore: false })
            throw new Error("Lost acknowledgement")
          },
        }),
      )
      const context = yield* Layer.build(
        ProjectHistory.layer.pipe(
          Layer.provideMerge(EventV2.layerWith(recovery.eventOptions)),
          Layer.provideMerge(Database.layerFromPath(":memory:")),
        ),
      )
      const events = yield* EventV2.Service.pipe(Effect.provide(context))
      // No ambient services: recovery must use the exact projection captured by EventV2.
      yield* events.recover
      yield* events.recover
      expect(calls).toEqual(["/v1/epoch", "/v1/claim", "/v1/read"])
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const history = yield* ProjectHistory.Service
        expect((yield* db.select().from(ProjectTable).get())?.name).toBe("Recovered project")
        expect(
          Exit.isFailure(
            yield* history.change(projectID, { type: "updated", name: "Uncertain", time: 300 }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* db.select().from(ProjectTable).get())?.name).toBe("Recovered project")
      }).pipe(Effect.provide(context))
      expect(Exit.isFailure(yield* events.recover.pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
      expect(calls).toEqual(["/v1/epoch", "/v1/claim", "/v1/read", "/v1/append"])
    }),
  )
})
