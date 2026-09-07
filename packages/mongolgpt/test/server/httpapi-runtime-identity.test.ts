import { NodeServices } from "@effect/platform-node"
import { EventV2 } from "@mongolgpt/core/event"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { Session } from "@mongolgpt/schema/session"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Server } from "../../src/server/server"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

const it = testEffectShared(Layer.mergeAll(NodeServices.layer, EventV2.defaultLayer))

describe("TCP application service identity", () => {
  it.live(
    "shares HTTP durable events with the CLI application runtime",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const bridge = yield* Effect.promise(() => AppRuntime.runPromise(EventV2Bridge.Service))
        expect(bridge.check).toBe(events.check)
        const observed: EventV2.Payload[] = []
        yield* Effect.acquireRelease(
          bridge.listen((event) =>
            Effect.sync(() => {
              observed.push(event)
            }),
          ),
          (unsubscribe) => unsubscribe,
        )
        const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (listener) => Effect.promise(() => listener.stop(true)),
        )
        const response = yield* Effect.promise(() =>
          fetch(new URL("/session", listener.url), {
            method: "POST",
            headers: { "x-mongolgpt-directory": directory },
          }),
        )
        expect(response.status).toBe(200)
        const session = Schema.decodeUnknownSync(SessionV1.SessionInfo)(yield* Effect.promise(() => response.json()))
        // EventV2 awaits its listeners before acknowledging the HTTP write.
        expect(
          observed.filter((event) => event.type === SessionV1.Event.Created.type).map((event) => event.data),
        ).toEqual([expect.objectContaining({ sessionID: session.id })])

        const nativeResponse = yield* Effect.promise(() =>
          fetch(new URL("/api/session", listener.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ location: { directory } }),
          }),
        )
        expect(nativeResponse.status).toBe(200)
        const native = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
          yield* Effect.promise(() => nativeResponse.json()),
        )
        expect(
          observed.filter((event) => event.type === SessionV1.Event.Created.type).map((event) => event.data),
        ).toEqual([
          expect.objectContaining({ sessionID: session.id }),
          expect.objectContaining({ sessionID: native.data.id }),
        ])

        yield* Effect.promise(() =>
          AppRuntime.runPromise(
            EventV2Bridge.Service.use((bridge) =>
              bridge.publish(SessionV1.Event.Updated, {
                sessionID: session.id,
                info: { ...session, title: "Shared runtime update" },
              }),
            ),
          ),
        )
        const updatedResponse = yield* Effect.promise(() =>
          fetch(new URL(`/session/${session.id}`, listener.url), {
            headers: { "x-mongolgpt-directory": directory },
          }),
        )
        expect(updatedResponse.status).toBe(200)
        const updated = Schema.decodeUnknownSync(SessionV1.SessionInfo)(
          yield* Effect.promise(() => updatedResponse.json()),
        )
        expect(updated.title).toBe("Shared runtime update")
      }),
    60_000,
  )

  it.live(
    "keeps authentication configuration fresh across TCP listeners",
    () =>
      Effect.gen(function* () {
        const previous = process.env.MONGOLGPT_SERVER_PASSWORD
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.MONGOLGPT_SERVER_PASSWORD
            else process.env.MONGOLGPT_SERVER_PASSWORD = previous
          }),
        )
        for (const password of ["first-listener-test", "second-listener-test"]) {
          process.env.MONGOLGPT_SERVER_PASSWORD = password
          yield* Effect.gen(function* () {
            const listener = yield* Effect.acquireRelease(
              Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
              (listener) => Effect.promise(() => listener.stop(true)),
            )
            const statuses: number[] = []
            for (const credential of ["first-listener-test", "second-listener-test"]) {
              const response = yield* Effect.promise(() =>
                fetch(new URL("/global/config", listener.url), {
                  headers: { authorization: `Basic ${btoa(`mongolgpt:${credential}`)}` },
                }),
              )
              statuses.push(response.status)
              yield* Effect.promise(() => response.arrayBuffer())
            }
            expect(statuses).toEqual(password === "first-listener-test" ? [200, 401] : [401, 200])
          }).pipe(Effect.scoped)
        }
      }),
    60_000,
  )
})
