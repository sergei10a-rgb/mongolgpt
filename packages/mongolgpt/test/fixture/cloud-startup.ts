import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import type { Payload, SerializedEvent } from "@mongolgpt/core/event"

const root = process.argv[2]
const failure = process.argv[3] === "failure"
assert(root && path.isAbsolute(root))
for (const name of ["home", "cache", "config", "data", "state", "workspace"]) {
  await fs.mkdir(path.join(root, name), { recursive: true })
}
Object.assign(process.env, {
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_STATE_HOME: path.join(root, "state"),
  MONGOLGPT_TEST_HOME: path.join(root, "home"),
  MONGOLGPT_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
  MONGOLGPT_DB: path.join(root, "projection.db"),
  MONGOLGPT_RUNTIME_MODE: "hosted",
  MONGOLGPT_CLOUD_HISTORY: "true",
  MONGOLGPT_DISABLE_DEFAULT_PLUGINS: "true",
  MONGOLGPT_DISABLE_MODELS_FETCH: "true",
  MONGOLGPT_DISABLE_AUTOUPDATE: "true",
  MONGOLGPT_MODELS_PATH: path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
  MONGOLGPT_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false }),
})
delete process.env.MONGOLGPT_SERVER_PASSWORD
delete process.env.MONGOLGPT_SERVER_USERNAME

const { Effect, Exit, Schema } = await import("effect")
const { SessionV1 } = await import("@mongolgpt/schema/session-v1")
const { Session } = await import("@mongolgpt/schema/session")
const { Project } = await import("@mongolgpt/schema/project")
const { EventV2 } = await import("@mongolgpt/core/event")
const directory = path.join(root, "workspace")
const sessionID = Session.ID.make("ses_cloud_startup")
const info = Schema.decodeUnknownSync(SessionV1.SessionInfo)({
  id: sessionID,
  projectID: Project.ID.global,
  directory,
  title: "Сэргээгдсэн сешн",
  slug: "cloud-startup",
  version: "test",
  time: { created: 100, updated: 100 },
})
const wire: SerializedEvent[] = [
  {
    id: EventV2.ID.make("evt_cloud_project"),
    aggregateID: Project.ID.global,
    seq: 0,
    type: "project.history.changed.1",
    data: {
      projectID: Project.ID.global,
      change: {
        type: "saved",
        info: { id: Project.ID.global, worktree: directory, sandboxes: [], time: { created: 100, updated: 100 } },
      },
    },
  },
  {
    id: EventV2.ID.make("evt_cloud_session"),
    aggregateID: sessionID,
    seq: 0,
    type: "session.created.1",
    data: Schema.encodeSync(SessionV1.Event.Created.data)({ sessionID, info }),
  },
]
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const calls: string[] = []
let loseReceipt = false
const original = globalThis.fetch
// The fixed internal host is provided by Cloudflare in production. This isolated child substitutes only that transport.
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname !== "history.mongolgpt.internal") {
      assert.equal(url.hostname, "127.0.0.1", "fixture must not access external services")
      return original(input, init)
    }
    calls.push(url.pathname)
    if (url.pathname === "/v1/epoch") return Response.json({ epoch: 0 })
    if (url.pathname === "/v1/claim") {
      const body = (await request.json()) as { writerID: string }
      return Response.json({ epoch: 1, writerID: body.writerID })
    }
    if (url.pathname === "/v1/read") {
      entered.resolve()
      await release.promise
      if (failure) throw new Error("private read failure")
      return Response.json({
        entries: wire.map((event, index) => ({ cursor: index + 1, deleted: false, event })),
        cursor: wire.length,
        hasMore: false,
      })
    }
    assert.equal(url.pathname, "/v1/append")
    if (loseReceipt) throw new Error("private lost receipt")
    const body = (await request.json()) as { event: SerializedEvent }
    wire.push(body.event)
    return Response.json({ cursor: wire.length })
  },
  { preconnect: original.preconnect },
)

const { AppRuntime } = await import("../../src/effect/app-runtime")
const { EventV2Bridge } = await import("../../src/event-v2-bridge")
const { Server } = await import("../../src/server/server")
const bridge = await AppRuntime.runPromise(EventV2Bridge.Service)
let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
let returned = false
const pending = Server.listen({ hostname: "127.0.0.1", port: 0 }).then(
  (value) => {
    returned = true
    listener = value
    return { ok: true as const, value }
  },
  (error) => {
    returned = true
    return { ok: false as const, error }
  },
)
try {
  await Promise.race([
    entered.promise,
    pending.then((result) => {
      throw new Error("listener settled before reading history", { cause: result.ok ? undefined : result.error })
    }),
  ])
  assert.equal(returned, false, "listener must not report readiness before recovery")
  assert(Exit.isFailure(await Effect.runPromiseExit(bridge.check)))
  release.resolve()
  const result = await pending
  assert.deepEqual(calls, ["/v1/epoch", "/v1/claim", "/v1/read"])
  if (failure) {
    assert.equal(result.ok, false)
    assert(Exit.isFailure(await Effect.runPromiseExit(bridge.check)))
  } else {
    assert(result.ok)
    await Effect.runPromise(bridge.check)
    const response = await fetch(new URL(`/api/session/${sessionID}`, result.value.url))
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /application\/json/)
    const data = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(await response.json())
    assert.equal(data.data.title, info.title)

    const observed: Payload[] = []
    const unsubscribe = await Effect.runPromise(
      bridge.listen((event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
      ),
    )
    try {
      const created = await fetch(new URL("/api/session", result.value.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: { directory } }),
      })
      assert.equal(created.status, 200)
      const data = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(await created.json())
      assert(
        observed.some((event) => Schema.is(SessionV1.Event.Created)(event) && event.data.sessionID === data.data.id),
      )
      assert(wire.some((event) => event.type === "session.created.1" && event.aggregateID === data.data.id))
    } finally {
      await Effect.runPromise(unsubscribe)
    }
    loseReceipt = true
    assert(
      Exit.isFailure(
        await Effect.runPromiseExit(
          bridge.publish(SessionV1.Event.Updated, {
            sessionID,
            info: { ...info, title: "Not acknowledged" },
          }),
        ),
      ),
    )
    const unavailable = await fetch(new URL("/global/health", result.value.url))
    assert.equal(unavailable.status, 503)
    const body = await unavailable.text()
    assert.match(body, /Cloud/)
    assert(!body.includes("private lost receipt"))
    assert.equal(calls.filter((route) => route === "/v1/claim").length, 1)
  }
  console.log(JSON.stringify({ cloudStartup: failure ? "closed-on-failure" : "recovered-and-fenced" }))
} finally {
  release.resolve()
  await listener?.stop(true)
  await AppRuntime.dispose()
  globalThis.fetch = original
}
