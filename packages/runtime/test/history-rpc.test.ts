import { describe, expect, test } from "bun:test"
import { createHistoryHandler, handleHistoryOutbound } from "../src/history-rpc"
import { HistoryError, type HistoryEvent, type HistoryScope } from "../src/history"

const scope = { accountID: "acc_test", workspaceID: "wrk_test" } satisfies HistoryScope
const url = "http://history.mongolgpt.internal/v1"

describe("history rpc", () => {
  test("fails closed when the internal outbound binding is missing", async () => {
    const response = await handleHistoryOutbound(request("/read", {}), {}, { params: scope })
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } })
  })

  test("routes fixed POST operations without echoing scope", async () => {
    const store = stubStore()
    const handler = createHistoryHandler(store, scope)
    expect(await json(await handler(request("/epoch", {})))).toEqual({ epoch: 7 })
    expect(await json(await handler(request("/claim", { expectedEpoch: 7, writerID: "writer_a" })))).toEqual({
      epoch: 8,
      writerID: "writer_a",
    })
    expect(await json(await handler(request("/append", appendBody())))).toEqual({ cursor: 11 })
    expect(
      await json(
        await handler(
          request("/erase", { epoch: 8, writerID: "writer_a", id: "evt_erase", aggregateID: "ses_a", seq: 1 }),
        ),
      ),
    ).toEqual({ cursor: 12 })
    expect(await json(await handler(request("/read", { after: 0, limit: 1 })))).toEqual({
      entries: [],
      cursor: 0,
      hasMore: false,
    })
    expect(store.calls).toEqual(["epoch", "claim", "append", "erase", "read"])
    expect(store.appended[0]?.type).toBe("session.next.context.updated.1")
    expect(store.appended[0]?.data.timestamp).toBe(1_717_171_717_000)
  })

  test("rejects malformed transport before calling the store", async () => {
    await expectInvalid(new Request(`${url}/epoch`, { method: "GET", headers: jsonContent() }))
    await expectInvalid(
      new Request(`${url}/epoch`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }),
    )
    await expectInvalid(
      new Request("http://example.invalid/v1/epoch", { method: "POST", headers: jsonContent(), body: "{}" }),
    )
    await expectInvalid(new Request(`${url}/epoch`, { method: "POST", headers: jsonContent(), body: "" }))
  })

  test("rejects extra keys and untrusted scope fields before calling the store", async () => {
    await expectInvalid(request("/epoch", { unexpected: true }))
    await expectInvalid(request("/claim", { expectedEpoch: 0, writerID: "writer_a", accountID: "attacker" }))
    await expectInvalid(request("/append", { ...appendBody(), event: { ...event(), extra: true } }))
  })

  test("rejects unknown, non-durable, schema-poisoned, and aggregate-mismatched events before calling the store", async () => {
    await expectInvalid(request("/append", { ...appendBody(), event: { ...event(), type: "missing.event.1" } }))
    await expectInvalid(request("/append", { ...appendBody(), event: { ...event(), type: "session.next.text.delta" } }))
    await expectInvalid(
      request("/append", { ...appendBody(), event: { ...event(), data: { ...event().data, timestamp: "bad" } } }),
    )
    await expectInvalid(request("/append", { ...appendBody(), event: { ...event(), aggregateID: "ses_other" } }))
  })

  test("accepts current session.created durable data with workspaceID and preserves encoded payload", async () => {
    const store = stubStore()
    const body = { epoch: 8, writerID: "writer_a", event: sessionCreatedEvent() }
    const original = structuredClone(body)
    const response = await createHistoryHandler(store, scope)(request("/append", body))

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ cursor: 11 })
    expect(body).toEqual(original)
    expect(store.appended).toHaveLength(1)
    expect(store.appended[0]?.type).toBe("session.created.1")
    expect(store.appended[0]?.aggregateID).toBe("ses_created")
    expect(store.appended[0]?.data).toEqual(original.event.data)
    expect(store.appended[0]?.data.info).toMatchObject({
      workspaceID: "wrk_domain",
      metadata: { accountID: "domain-data" },
    })
  })

  test("maps native session.deleted append to content-free erase", async () => {
    const store = stubStore()
    const response = await createHistoryHandler(
      store,
      scope,
    )(request("/append", { epoch: 8, writerID: "writer_a", event: sessionDeletedEvent() }))

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ cursor: 12 })
    expect(store.calls).toEqual(["erase"])
    expect(store.appended).toEqual([])
    expect(store.erased).toEqual([{ id: "evt_session_deleted", aggregateID: "ses_deleted", seq: 2 }])
  })

  test("enforces a streaming body cap before calling the store", async () => {
    await expectInvalid(
      new Request(`${url}/epoch`, {
        method: "POST",
        headers: jsonContent(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 4097))
            controller.close()
          },
        }),
      }),
    )
  })

  test("maps safe store errors without leaking details", async () => {
    const store = stubStore({ append: new HistoryError("conflict"), read: new Error("private SQL detail") })
    const handler = createHistoryHandler(store, scope)
    const conflict = await handler(request("/append", appendBody()))
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toEqual({
      error: { code: "conflict", message: "Cloud түүхийн дараалал зөрсөн байна. Сессийг дахин ачаална уу." },
    })
    const unavailable = await handler(request("/read", {}))
    expect(unavailable.status).toBe(503)
    expect(JSON.stringify(await json(unavailable))).not.toContain("private SQL detail")
    expect(conflict.headers.get("cache-control")).toBe("no-store")
  })
})

function stubStore(errors: Partial<Record<"append" | "read", Error>> = {}) {
  const calls = new Array<string>()
  const appended = new Array<HistoryEvent>()
  const erased = new Array<Pick<HistoryEvent, "id" | "aggregateID" | "seq">>()
  return {
    calls,
    appended,
    erased,
    epoch: async () => {
      calls.push("epoch")
      return 7
    },
    claim: async (_scope: HistoryScope, input: { expectedEpoch: number; writerID: string }) => {
      calls.push("claim")
      return { ...scope, epoch: input.expectedEpoch + 1, writerID: input.writerID }
    },
    append: async (_lease: unknown, event: HistoryEvent) => {
      calls.push("append")
      if (errors.append) throw errors.append
      appended.push(event)
      return { cursor: 11 }
    },
    erase: async (_lease: unknown, event: Pick<HistoryEvent, "id" | "aggregateID" | "seq">) => {
      calls.push("erase")
      erased.push(event)
      return { cursor: 12 }
    },
    read: async () => {
      calls.push("read")
      if (errors.read) throw errors.read
      return { entries: [], cursor: 0, hasMore: false }
    },
  }
}

function appendBody() {
  return { epoch: 8, writerID: "writer_a", event: event() }
}

function event() {
  return {
    id: "evt_context",
    aggregateID: "ses_a",
    seq: 0,
    type: "session.next.context.updated.1",
    data: {
      timestamp: 1_717_171_717_000,
      sessionID: "ses_a",
      messageID: "msg_a",
      text: "hello",
    },
  }
}

function sessionCreatedEvent() {
  return {
    id: "evt_session_created",
    aggregateID: "ses_created",
    seq: 0,
    type: "session.created.1",
    data: {
      sessionID: "ses_created",
      info: {
        id: "ses_created",
        slug: "created",
        projectID: "global",
        workspaceID: "wrk_domain",
        directory: "C:\\Codex\\opencode",
        title: "Created",
        version: "0.1.0",
        metadata: { accountID: "domain-data" },
        time: { created: 1_717_171_717_000, updated: 1_717_171_717_000 },
      },
    },
  }
}

function sessionDeletedEvent() {
  return {
    id: "evt_session_deleted",
    aggregateID: "ses_deleted",
    seq: 2,
    type: "session.deleted.1",
    data: {
      sessionID: "ses_deleted",
      info: {
        id: "ses_deleted",
        slug: "deleted",
        projectID: "global",
        workspaceID: "wrk_domain",
        directory: "C:\\Codex\\opencode",
        title: "Deleted",
        version: "0.1.0",
        metadata: { secret: "must-not-be-appended" },
        time: { created: 1_717_171_717_000, updated: 1_717_171_717_001 },
      },
    },
  }
}

function request(path: string, body: unknown) {
  return new Request(`${url}${path}`, { method: "POST", headers: jsonContent(), body: JSON.stringify(body) })
}

function jsonContent() {
  return { "content-type": "application/json" }
}

async function json(response: Response) {
  return response.json()
}

async function expectInvalid(input: Request) {
  const store = stubStore()
  const response = await createHistoryHandler(store, scope)(input)
  expect(response.status).toBe(400)
  expect(store.calls).toEqual([])
  expect(JSON.stringify(await json(response))).not.toContain("SQL")
  expect(response.headers.get("cache-control")).toBe("no-store")
}
