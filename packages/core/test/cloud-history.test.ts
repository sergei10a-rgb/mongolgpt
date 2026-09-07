import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Event } from "@mongolgpt/schema/event"
import { SessionEvent } from "@mongolgpt/schema/session-event"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { createCloudHistory } from "../src/event/cloud-history"
import type { EventV2 } from "../src/event"

const base = "http://history.mongolgpt.internal/v1"
const maxRequestBytes = 1024 * 1024 + 4096
const maxResponseBytes = 11 * 1024 * 1024
const encoder = new TextEncoder()
const event = {
  id: Event.ID.make("evt_cloud"),
  aggregateID: "ses_cloud",
  seq: 0,
  type: "session.created.1",
  data: {
    sessionID: "ses_cloud",
    info: { workspaceID: "domain-workspace", metadata: { accountID: "domain-account" } },
  },
} satisfies EventV2.SerializedEvent

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } })
}

async function readClaim(request: Request) {
  return Schema.decodeUnknownSync(Schema.Struct({ expectedEpoch: Schema.Int, writerID: Schema.String }))(
    await request.clone().json(),
  )
}

async function readAppend(request: Request) {
  return (await request.clone().json()) as { epoch: number; writerID: string; event: EventV2.SerializedEvent }
}

function fixture(respond?: (request: Request) => Response | undefined | Promise<Response | undefined>) {
  const requests: Request[] = []
  const client = createCloudHistory({
    request: async (request) => {
      requests.push(request)
      const custom = await respond?.(request)
      if (custom) return custom
      switch (new URL(request.url).pathname) {
        case "/v1/epoch":
          return response({ epoch: 7 })
        case "/v1/claim": {
          const body = await readClaim(request)
          return response({ epoch: body.expectedEpoch + 1, writerID: body.writerID })
        }
        case "/v1/append":
          return response({ cursor: 1 })
        case "/v1/read": {
          const body = Schema.decodeUnknownSync(Schema.Struct({ after: Schema.Int }))(await request.clone().json())
          return response({ entries: [], cursor: body.after, hasMore: false })
        }
        default:
          throw new Error("Unexpected route")
      }
    },
  })
  return { client, requests }
}

async function rejection(effect: Effect.Effect<unknown>) {
  const error = await Effect.runPromise(effect).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeDefined()
  expect(String(error)).not.toContain("server-secret")
  expect(String(error)).toContain("Cloud")
  return String(error)
}

describe("native cloud history transport", () => {
  test("binds claim and every read to an immutable checkpoint ID", async () => {
    const requests: Request[] = []
    const options = {
      checkpointID: "checkpoint_native",
      request: async (request: Request) => {
        requests.push(request)
        if (request.url.endsWith("/epoch")) return response({ epoch: 2 })
        if (request.url.endsWith("/claim")) {
          const body = await readClaim(request)
          return response({ epoch: 3, writerID: body.writerID })
        }
        return response({ entries: [], cursor: 0, hasMore: false })
      },
    }
    const client = createCloudHistory(options)
    options.checkpointID = "mutated_after_creation"
    await Effect.runPromise(client.initialize)
    await Effect.runPromise(client.read(0))
    expect(client.checkpointID).toBe("checkpoint_native")
    expect(await requests[1].json()).toMatchObject({ checkpointID: "checkpoint_native" })
    expect(await requests[2].json()).toEqual({ after: 0, limit: 10, checkpointID: "checkpoint_native" })
    expect(() => createCloudHistory({ checkpointID: "../invalid" })).toThrow()
  })

  test("is lazy, requires initialization and uses only the fixed POST contract", async () => {
    const { client, requests } = fixture()
    expect(requests).toHaveLength(0)
    expect(await rejection(client.append(event))).toContain("эхлээгүй")
    expect(await rejection(client.read(0))).toContain("эхлээгүй")
    expect(requests).toHaveLength(0)
    await Effect.runPromise(client.initialize)
    await Effect.runPromise(client.initialize)
    await Effect.runPromise(client.append(event))
    expect(await Effect.runPromise(client.read(17))).toEqual({ entries: [], cursor: 17, hasMore: false })
    expect(requests.map((request) => request.url)).toEqual([
      `${base}/epoch`,
      `${base}/claim`,
      `${base}/append`,
      `${base}/read`,
    ])
    for (const request of requests) {
      expect(request.method).toBe("POST")
      expect(request.redirect).toBe("error")
      expect(request.signal.aborted).toBe(false)
      expect(request.headers.get("content-type")).toBe("application/json")
      expect(request.headers.has("authorization")).toBe(false)
    }
    expect(await requests[0].json()).toEqual({})
    const claim = await readClaim(requests[1])
    expect(claim).toEqual({
      expectedEpoch: 7,
      writerID: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    })
    expect(await requests[2].json()).toEqual({ epoch: 8, writerID: claim.writerID, event })
    expect(await requests[3].json()).toEqual({ after: 17, limit: 10 })
    const another = fixture()
    await Effect.runPromise(another.client.initialize)
    expect((await readClaim(another.requests[1])).writerID).not.toBe(claim.writerID)
  })

  test("shares delayed epoch and claim without admitting reads or appends early", async () => {
    const epoch = Promise.withResolvers<Response>()
    const claim = Promise.withResolvers<Response>()
    const epochEntered = Promise.withResolvers<void>()
    const claimEntered = Promise.withResolvers<Request>()
    const { client, requests } = fixture((request) => {
      if (request.url.endsWith("/epoch")) {
        epochEntered.resolve()
        return epoch.promise
      }
      if (request.url.endsWith("/claim")) {
        claimEntered.resolve(request)
        return claim.promise
      }
    })
    const first = Effect.runPromise(client.initialize)
    await epochEntered.promise
    const second = Effect.runPromise(client.initialize)
    await rejection(client.append(event))
    await rejection(client.read(0))
    expect(requests).toHaveLength(1)
    epoch.resolve(response({ epoch: 12 }))
    const pending = await claimEntered.promise
    await rejection(client.append(event))
    await rejection(client.read(0))
    expect(requests).toHaveLength(2)
    const body = await readClaim(pending)
    claim.resolve(response({ epoch: 13, writerID: body.writerID }))
    await Promise.all([first, second])
    await Effect.runPromise(client.append(event))
    expect(await requests[2].json()).toEqual({ epoch: 13, writerID: body.writerID, event })
  })

  test("keeps a failed initialization outcome and never retries or reclaims", async () => {
    const { client, requests } = fixture((request) =>
      request.url.endsWith("/claim")
        ? response({ error: { code: "fenced", message: "server-secret" } }, 409)
        : undefined,
    )
    expect(await rejection(client.initialize)).toContain("шинэчлэгдсэн")
    await rejection(client.initialize)
    await rejection(client.append(event))
    await rejection(client.read(0))
    expect(requests).toHaveLength(2)
  })

  test("cancels initialization without accepting a late epoch or issuing another claim", async () => {
    const epoch = Promise.withResolvers<Response>()
    const entered = Promise.withResolvers<Request>()
    const { client, requests } = fixture((request) => {
      entered.resolve(request)
      return epoch.promise
    })
    const controller = new AbortController()
    const initializing = Effect.runPromise(client.initialize, { signal: controller.signal }).then(
      () => false,
      () => true,
    )
    const request = await entered.promise
    controller.abort()
    expect(await initializing).toBe(true)
    expect(request.signal.aborted).toBe(true)
    epoch.resolve(response({ epoch: 7 }))
    await rejection(client.initialize)
    await rejection(client.append(event))
    expect(requests).toHaveLength(1)
  })

  test("allows a shared initialization to finish when a second waiter is interrupted", async () => {
    const epoch = Promise.withResolvers<Response>()
    const entered = Promise.withResolvers<Request>()
    const { client, requests } = fixture((request) => {
      if (!request.url.endsWith("/epoch")) return
      entered.resolve(request)
      return epoch.promise
    })
    const first = Effect.runPromise(client.initialize)
    const request = await entered.promise
    const controller = new AbortController()
    const second = Effect.runPromise(client.initialize, { signal: controller.signal }).then(
      () => false,
      () => true,
    )
    controller.abort()
    expect(await second).toBe(true)
    expect(request.signal.aborted).toBe(false)
    epoch.resolve(response({ epoch: 7 }))
    await first
    await Effect.runPromise(client.initialize)
    await Effect.runPromise(client.append(event))
    expect(requests).toHaveLength(3)
  })

  test("never reclaims after a fenced read", async () => {
    const { client, requests } = fixture((request) =>
      request.url.endsWith("/read")
        ? response({ error: { code: "fenced", message: "server-secret" } }, 409)
        : undefined,
    )
    await Effect.runPromise(client.initialize)
    await rejection(client.read(0))
    await rejection(client.initialize)
    await rejection(client.append(event))
    expect(requests).toHaveLength(3)
  })

  test("requires the exact next epoch and this client's writer in the claim receipt", async () => {
    for (const changed of [
      { epoch: 7 },
      { epoch: 9 },
      { writerID: "different-writer" },
      { accountID: "server-secret" },
    ]) {
      const { client, requests } = fixture(async (request) => {
        if (!request.url.endsWith("/claim")) return
        const body = await readClaim(request)
        return response({ epoch: 8, writerID: body.writerID, ...changed })
      })
      await rejection(client.initialize)
      await rejection(client.initialize)
      await rejection(client.append(event))
      expect(requests).toHaveLength(2)
    }
  })

  test("rejects invalid epoch receipts before attempting a claim", async () => {
    for (const value of [
      null,
      {},
      { epoch: -1 },
      { epoch: 0.5 },
      { epoch: Number.MAX_SAFE_INTEGER },
      { epoch: 2 ** 53 },
      { epoch: 0, scope: {} },
    ]) {
      const { client, requests } = fixture(() => response(value))
      await rejection(client.initialize)
      await rejection(client.initialize)
      expect(requests).toHaveLength(1)
    }
  })

  test("preserves encoded transformed dates and domain fields without mutating the payload", async () => {
    const { client, requests } = fixture()
    await Effect.runPromise(client.initialize)
    const definition = SessionEvent.ContextUpdated
    const decoded = Schema.decodeUnknownSync(definition.data)({
      sessionID: "ses_cloud",
      timestamp: 1_717_171_717_000,
      messageID: "msg_cloud",
      text: "Түүх",
    })
    expect(DateTime.isDateTime(decoded.timestamp)).toBe(true)
    const wire = {
      ...event,
      type: Event.versionedType(definition.type, definition.durable!.version),
      data: Schema.encodeSync(definition.data)(decoded),
    }
    const before = structuredClone(wire)
    Object.freeze(wire.data)
    Object.freeze(wire)
    await Effect.runPromise(client.append(wire))
    const sent = (await readAppend(requests[2])).event
    expect(sent).toEqual(before)
    expect(sent.data.timestamp).toBe(1_717_171_717_000)
    expect(wire).toEqual(before)
    await Effect.runPromise(client.append(event))
    expect((await readAppend(requests[3])).event.data).toEqual(event.data)
  })

  test("sends native deletion unchanged through append for the RPC to erase", async () => {
    const { client, requests } = fixture()
    await Effect.runPromise(client.initialize)
    const definition = SessionV1.Event.Deleted
    const data = Schema.decodeUnknownSync(definition.data)({
      sessionID: "ses_cloud",
      info: {
        id: "ses_cloud",
        slug: "cloud",
        projectID: "global",
        directory: "/workspace",
        title: "Deleted title",
        version: "test",
        time: { created: 1, updated: 2 },
      },
    })
    const deleted = {
      ...event,
      seq: 1,
      type: Event.versionedType(definition.type, definition.durable!.version),
      data: Schema.encodeSync(definition.data)(data),
    }
    await Effect.runPromise(client.append(deleted))
    expect(requests[2].url).toBe(`${base}/append`)
    expect((await readAppend(requests[2])).event).toEqual(deleted)
  })

  test("rejects malformed local wire events and cursors without a request", async () => {
    const { client, requests } = fixture()
    await Effect.runPromise(client.initialize)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const invalid = [
      { ...event, accountID: "server-secret" },
      { ...event, scope: {} },
      { ...event, workspaceID: "scope" },
      { ...event, type: "session.created" },
      { ...event, type: "session.created.0" },
      { ...event, id: "bad-id" },
      { ...event, aggregateID: "x'; DROP TABLE history;--" },
      { ...event, seq: -1 },
      { ...event, seq: 0.5 },
      { ...event, seq: 2 ** 53 },
      { ...event, data: [] },
      { ...event, data: null },
      { ...event, data: { timestamp: DateTime.makeUnsafe(1) } },
      { ...event, data: { timestamp: new Date(1) } },
      { ...event, data: { invalid: undefined } },
      { ...event, data: { invalid: Number.NaN } },
      { ...event, data: { invalid: BigInt(1) } },
      { ...event, data: { invalid: new Array(1) } },
      { ...event, data: cycle },
    ]
    for (const value of invalid) await rejection(client.append(value as EventV2.SerializedEvent))
    for (const after of [-1, 0.5, Number.NaN, 2 ** 53]) await rejection(client.read(after))
    expect(requests).toHaveLength(2)
  })

  test("bounds exact outgoing UTF-8 bytes without changing the accepted envelope", async () => {
    const { client, requests } = fixture()
    await Effect.runPromise(client.initialize)
    const claim = await readClaim(requests[1])
    const wire = { ...event, data: { text: "" } }
    const overhead = encoder.encode(JSON.stringify({ epoch: 8, writerID: claim.writerID, event: wire })).byteLength
    const available = maxRequestBytes - overhead
    wire.data.text = "ү".repeat(Math.floor(available / 2)) + "x".repeat(available % 2)
    const exact = JSON.stringify({ epoch: 8, writerID: claim.writerID, event: wire })
    expect(encoder.encode(exact).byteLength).toBe(maxRequestBytes)
    await Effect.runPromise(client.append(wire))
    expect(await requests[2].text()).toBe(exact)
    wire.data.text += "x"
    await rejection(client.append(wire))
    expect(requests).toHaveLength(3)
  })

  test("validates increasing global cursors across interleaved aggregates and content-free tombstones", async () => {
    const page = {
      entries: [
        { cursor: 7, deleted: false as const, event },
        { cursor: 11, deleted: true as const, aggregateID: "ses_other", id: Event.ID.make("evt_deleted"), seq: 3 },
        { cursor: 20, deleted: false as const, event: { ...event, seq: 1 } },
      ],
      cursor: 20,
      hasMore: true,
    }
    const { client } = fixture((request) => (request.url.endsWith("/read") ? response(page) : undefined))
    await Effect.runPromise(client.initialize)
    expect(await Effect.runPromise(client.read(5))).toEqual(page)
  })

  test("rejects malformed pages, non-versioned events, extra fields and tombstone payloads", async () => {
    const entry = { cursor: 2, deleted: false, event }
    const valid = { entries: [entry], cursor: 2, hasMore: false }
    const invalid = [
      null,
      {},
      { ...valid, scope: {} },
      { ...valid, hasMore: "false" },
      { ...valid, cursor: 3 },
      { ...valid, cursor: 2 ** 53 },
      { entries: [], cursor: 2, hasMore: false },
      { entries: [], cursor: 1, hasMore: true },
      { ...valid, entries: [entry, entry] },
      { entries: [{ ...entry, cursor: 3 }, entry], cursor: 2, hasMore: false },
      { ...valid, entries: [{ ...entry, cursor: 1 }] },
      { ...valid, entries: [{ ...entry, cursor: 0 }] },
      { ...valid, entries: [{ ...entry, cursor: 1.5 }] },
      { ...valid, entries: [{ ...entry, workspaceID: "server-secret" }] },
      { ...valid, entries: [{ ...entry, event: { ...event, scope: {} } }] },
      { ...valid, entries: [{ ...entry, event: { ...event, type: "session.created" } }] },
      { ...valid, entries: [{ ...entry, event: { ...event, seq: -1 } }] },
      { ...valid, entries: [{ ...entry, event: { ...event, data: [] } }] },
      {
        ...valid,
        entries: [{ cursor: 2, deleted: true, aggregateID: "ses_cloud", id: "evt_deleted", seq: 1, data: {} }],
      },
      { ...valid, entries: [{ cursor: 2, deleted: true, aggregateID: "ses_cloud", id: "evt_deleted", seq: 1, event }] },
      { entries: Array.from({ length: 11 }, (_, i) => ({ ...entry, cursor: i + 2 })), cursor: 12, hasMore: false },
    ]
    for (const page of invalid) {
      const { client, requests } = fixture((request) => (request.url.endsWith("/read") ? response(page) : undefined))
      await Effect.runPromise(client.initialize)
      await rejection(client.read(1))
      expect(requests).toHaveLength(3)
    }
  })

  test("rejects HTML, malformed JSON, invalid statuses and untrusted error envelopes", async () => {
    const cases = [
      () => new Response("<html>server-secret</html>", { headers: { "content-type": "text/html" } }),
      () => new Response("server-secret", { headers: { "content-type": "application/json" } }),
      () => new Response("{}"),
      () => new Response(null, { status: 204, headers: { "content-type": "application/json" } }),
      () => response({ epoch: 7 }, 201),
      () => response({ epoch: 7 }, 302),
      () => response({ error: { code: "fenced", message: "server-secret" } }, 503),
      () => response({ error: { code: "unknown", message: "server-secret" } }, 500),
      () => response({ error: { code: "unavailable", message: "server-secret", details: "server-secret" } }, 503),
      () => new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json" } }),
    ]
    for (const make of cases) {
      const { client, requests } = fixture(() => make())
      expect(await rejection(client.initialize)).toContain("холбогдож чадсангүй")
      expect(requests).toHaveLength(1)
    }
  })

  test("maps only valid status/code pairs to sanitized Mongolian errors", async () => {
    for (const [code, status, text] of [
      ["invalid_input", 400, "буруу"],
      ["conflict", 409, "дараалал"],
      ["fenced", 409, "шинэчлэгдсэн"],
      ["unavailable", 503, "холбогдож чадсангүй"],
    ] as const) {
      const { client } = fixture(() => response({ error: { code, message: "server-secret" } }, status))
      expect(await rejection(client.initialize)).toContain(text)
    }
  })

  test("never retries writes or reclaims after lost acknowledgements, malformed receipts or fencing", async () => {
    const cases = [
      () => {
        throw new Error("server-secret")
      },
      () => response({ cursor: 0 }),
      () => response({ cursor: 0.5 }),
      () => response({ cursor: 2 ** 53 }),
      () => response({ cursor: 1, accountID: "server-secret" }),
      () => response({ error: { code: "fenced", message: "server-secret" } }, 409),
    ]
    for (const make of cases) {
      const { client, requests } = fixture((request) => (request.url.endsWith("/append") ? make() : undefined))
      await Effect.runPromise(client.initialize)
      await rejection(client.append(event))
      await rejection(client.append(event))
      await rejection(client.read(0))
      await rejection(client.initialize)
      expect(requests).toHaveLength(3)
    }
  })

  test("bounds streamed response bytes and cancels even with a false content-length", async () => {
    let cancelled = false
    const { client } = fixture((request) => {
      if (!request.url.endsWith("/read")) return
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(maxResponseBytes).fill(32))
            controller.enqueue(Uint8Array.of(32))
          },
          cancel() {
            cancelled = true
            return new Promise<void>(() => {})
          },
        }),
        { headers: { "content-type": "application/json", "content-length": "1" } },
      )
    })
    await Effect.runPromise(client.initialize)
    await rejection(client.read(0))
    expect(cancelled).toBe(true)
  })

  test("accepts an exact 11 MiB response and preserves the wire payload", async () => {
    const page = {
      entries: [{ cursor: 1, deleted: false as const, event: { ...event, data: { text: "Түүх" } } }],
      cursor: 1,
      hasMore: false,
    }
    const value = JSON.stringify(page)
    const bytes = encoder.encode(value + " ".repeat(maxResponseBytes - encoder.encode(value).byteLength))
    expect(bytes.byteLength).toBe(maxResponseBytes)
    const { client } = fixture((request) =>
      request.url.endsWith("/read")
        ? new Response(bytes, { headers: { "content-type": "application/json", "content-length": "999999999" } })
        : undefined,
    )
    await Effect.runPromise(client.initialize)
    expect(await Effect.runPromise(client.read(0))).toEqual(page)
  })

  test("propagates Effect interruption to the actual request signal and cancels the body", async () => {
    const entered = Promise.withResolvers<Request>()
    let cancelled = false
    const { client } = fixture((request) => {
      if (!request.url.endsWith("/append")) return
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            entered.resolve(request)
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    })
    await Effect.runPromise(client.initialize)
    const controller = new AbortController()
    const writing = Effect.runPromise(client.append(event), { signal: controller.signal }).then(
      () => false,
      () => true,
    )
    const request = await entered.promise
    controller.abort()
    expect(await writing).toBe(true)
    expect(request.signal.aborted).toBe(true)
    expect(cancelled).toBe(true)
    await rejection(client.initialize)
  })

  test("aborts stalled headers and response streams after 15 seconds without retries", async () => {
    const headers = Promise.withResolvers<Response>()
    const signals: AbortSignal[] = []
    let cancelled = false
    let lateCancelled = false
    const first = fixture((request) => {
      if (!request.url.endsWith("/append")) return
      signals.push(request.signal)
      return headers.promise
    })
    const second = fixture((request) => {
      if (!request.url.endsWith("/read")) return
      signals.push(request.signal)
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    })
    await Promise.all([Effect.runPromise(first.client.initialize), Effect.runPromise(second.client.initialize)])
    const start = performance.now()
    await Promise.all([rejection(first.client.append(event)), rejection(second.client.read(0))])
    expect(performance.now() - start).toBeGreaterThanOrEqual(14_900)
    expect(performance.now() - start).toBeLessThan(19_000)
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(cancelled).toBe(true)
    expect(first.requests).toHaveLength(3)
    expect(second.requests).toHaveLength(3)
    headers.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            lateCancelled = true
          },
        }),
      ),
    )
    await headers.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(lateCancelled).toBe(true)
  }, 20_000)
})
