import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { createCloudHistory } from "@mongolgpt/core/event/cloud-history"
import { createCloudRecovery } from "@mongolgpt/core/event/cloud-recovery"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { Session } from "@mongolgpt/schema/session"
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { historyLayer } from "../../src/server/routes/instance/httpapi/middleware/history"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))

function recovering() {
  const cloud = createCloudHistory({
    request: async (request) => {
      const route = new URL(request.url).pathname
      const body = (await request.json()) as { writerID?: string; after?: number }
      const data = route.endsWith("/epoch")
        ? { epoch: 0 }
        : route.endsWith("/claim")
          ? { epoch: 1, writerID: body.writerID }
          : { entries: [], cursor: body.after, hasMore: false }
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
    },
  })
  return createCloudRecovery(cloud)
}

describe("HttpApi history admission", () => {
  it.live("blocks reads, writes, health and stream handshakes until startup completes", () =>
    Effect.gen(function* () {
      const recovery = recovering()
      yield* Effect.gen(function* () {
        let handled = 0
        const probe = Effect.sync(() => {
          handled++
          return HttpServerResponse.jsonUnsafe({ healthy: true })
        })
        yield* Layer.mergeAll(
          HttpRouter.add("GET", "/session", probe),
          HttpRouter.add("POST", "/session", probe),
          HttpRouter.add("GET", "/global/health", probe),
          HttpRouter.add("GET", "/event", probe),
          HttpRouter.add("GET", "/pty/connect", probe),
        ).pipe(Layer.provide(historyLayer), HttpRouter.serve, Layer.build)
        for (const route of [
          HttpClientRequest.get("/session"),
          HttpClientRequest.post("/session"),
          HttpClientRequest.get("/global/health"),
          HttpClientRequest.get("/event"),
          HttpClientRequest.get("/pty/connect"),
        ]) {
          const response = yield* HttpClient.execute(route)
          expect(response.status).toBe(503)
          expect(response.headers["content-type"]).toContain("application/json")
          expect(response.headers["cache-control"]).toBe("no-store")
          expect(response.headers["retry-after"]).toBe("5")
          expect(yield* response.json).toEqual({
            name: "UnknownError",
            data: { message: "Cloud түүхийн хадгалалт бэлэн биш байна. Түр хүлээгээд дахин оролдоно уу." },
          })
        }
        expect(handled).toBe(0)
        yield* recovery.recover
        const response = yield* HttpClient.execute(HttpClientRequest.get("/global/health"))
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({ healthy: true })
        expect(handled).toBe(1)
      }).pipe(
        Effect.provide(
          EventV2.layerWith(recovery.eventOptions).pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))),
        ),
      )
    }),
  )

  it.live("suppresses a stale response and subsequent direct reads after uncertain remote acknowledgement", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        let handled = 0
        const poison = events
          .publish(SessionV1.Event.MessageRemoved, {
            sessionID: Session.ID.make("ses_history_fenced"),
            messageID: SessionV1.MessageID.make("msg_history_fenced"),
          })
          .pipe(Effect.exit)
        yield* Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/race",
            Effect.gen(function* () {
              handled++
              expect(Exit.isFailure(yield* poison)).toBe(true)
              return HttpServerResponse.jsonUnsafe({ private: "stale projected content" })
            }),
          ),
          HttpRouter.add(
            "GET",
            "/session",
            Effect.sync(() => {
              handled++
              return HttpServerResponse.jsonUnsafe({ private: "must not be served" })
            }),
          ),
        ).pipe(Layer.provide(historyLayer), HttpRouter.serve, Layer.build)
        for (const url of ["/race", "/session"]) {
          const response = yield* HttpClient.execute(HttpClientRequest.get(url))
          expect(response.status).toBe(503)
          const body = yield* response.text
          expect(body).not.toContain("private")
          expect(body).not.toContain("secret SQL")
          expect(body).toContain("хадгалалт бэлэн биш")
        }
        expect(handled).toBe(1)
      }).pipe(
        Effect.provide(
          EventV2.layerWith({ journal: { append: () => Effect.die("secret SQL") } }).pipe(
            Layer.provideMerge(Database.layerFromPath(":memory:")),
          ),
        ),
      )
    }),
  )
})
