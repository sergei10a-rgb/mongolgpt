import { Effect, Schema } from "effect"
import { Event } from "@mongolgpt/schema/event"
import type { EventV2 } from "../event"

const base = "http://history.mongolgpt.internal/v1"
const maxRequestBytes = 1024 * 1024 + 4096
const maxResponseBytes = 11 * 1024 * 1024
const encoder = new TextEncoder()
const messages = {
  not_initialized: "Cloud түүхийн холболт эхлээгүй байна.",
  invalid_input: "Cloud түүхийн өгөгдөл буруу байна.",
  conflict: "Cloud түүхийн дараалал зөрсөн байна. Сессийг дахин ачаална уу.",
  fenced: "Cloud runtime шинэчлэгдсэн байна. Сессийг дахин ачаална уу.",
  unavailable: "Cloud түүхийн үйлчилгээнд холбогдож чадсангүй.",
} as const

class CloudHistoryError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code])
    this.name = "CloudHistoryError"
  }
}

const Integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const PositiveInteger = Integer.check(Schema.isGreaterThan(0))
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/))
const EventID = Event.ID.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/))
const WireEvent = Schema.Struct({
  id: EventID,
  aggregateID: Identifier,
  seq: Integer,
  type: Identifier.check(Schema.isPattern(/\.[1-9][0-9]*$/)),
  data: Schema.Record(Schema.String, Schema.Json),
})
const Epoch = Schema.Struct({ epoch: Integer })
const Lease = Schema.Struct({ epoch: PositiveInteger, writerID: Identifier })
const Receipt = Schema.Struct({ cursor: PositiveInteger })
const Entry = Schema.Union([
  Schema.Struct({ cursor: PositiveInteger, deleted: Schema.Literal(false), event: WireEvent }),
  Schema.Struct({
    cursor: PositiveInteger,
    deleted: Schema.Literal(true),
    aggregateID: Identifier,
    id: EventID,
    seq: Integer,
  }),
])
const Page = Schema.Struct({
  entries: Schema.Array(Entry).check(Schema.isMaxLength(10)),
  cursor: Integer,
  hasMore: Schema.Boolean,
})
export type Page = typeof Page.Type

const Failure = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals(["invalid_input", "conflict", "fenced", "unavailable"]),
    message: Schema.String,
  }),
})
const statuses = { invalid_input: 400, conflict: 409, fenced: 409, unavailable: 503 } as const

export function createCloudHistory(options: { readonly request?: (request: Request) => Promise<Response> } = {}) {
  const request = options.request ?? ((request: Request) => fetch(request))
  const writerID = crypto.randomUUID()
  let lease: typeof Lease.Type | undefined
  let initialization: Promise<void> | undefined
  let failure: CloudHistoryError | undefined

  function ready() {
    if (failure) throw failure
    if (!lease) throw new CloudHistoryError("not_initialized")
    return lease
  }

  async function rpc<A>(
    path: "epoch" | "claim" | "append" | "read",
    body: Uint8Array,
    schema: Schema.Decoder<A>,
    signal: AbortSignal,
  ) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const timeout = setTimeout(abort, 15_000)
    signal.addEventListener("abort", abort, { once: true })
    const interrupted = Promise.withResolvers<never>()
    const reject = () => interrupted.reject(new CloudHistoryError("unavailable"))
    controller.signal.addEventListener("abort", reject, { once: true })
    if (signal.aborted) abort()
    try {
      return await Promise.race([
        interrupted.promise,
        (async () => {
          controller.signal.throwIfAborted()
          const response = await request(
            new Request(`${base}/${path}`, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json", "cache-control": "no-store" },
              body: new Uint8Array(body).buffer,
              redirect: "error",
              signal: controller.signal,
            }),
          )
          if (
            controller.signal.aborted ||
            response.redirected ||
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
          ) {
            void response.body?.cancel().catch(() => {})
            throw new CloudHistoryError("unavailable")
          }
          const value = await readJson(response, controller.signal)
          if (response.status !== 200) {
            const error = decode(Failure, value).error
            if (statuses[error.code] !== response.status) throw new CloudHistoryError("unavailable")
            throw new CloudHistoryError(error.code)
          }
          return decode(schema, value)
        })(),
      ])
    } catch (error) {
      const safe = sanitize(error)
      if (safe.code === "fenced" || safe.code === "conflict") failure = safe
      throw safe
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", reject)
    }
  }

  const initialize = perform((signal) => {
    if (failure) return Promise.reject(failure)
    // Keep the same outcome, including rejection: an uncertain claim must never start a new CAS.
    return (initialization ??= (async () => {
      try {
        const expected = await rpc("epoch", json({}), Epoch, signal)
        if (expected.epoch === Number.MAX_SAFE_INTEGER) throw new CloudHistoryError("unavailable")
        const claimed = await rpc("claim", json({ expectedEpoch: expected.epoch, writerID }), Lease, signal)
        if (claimed.epoch !== expected.epoch + 1 || claimed.writerID !== writerID) throw new CloudHistoryError("fenced")
        lease = claimed
      } catch (error) {
        failure = sanitize(error)
        throw failure
      }
    })())
  })

  const append = (event: EventV2.SerializedEvent): Effect.Effect<void> =>
    perform(async (signal) => {
      const current = ready()
      // This boundary receives wire JSON. Reject class instances instead of invoking Date/DateTime.toJSON.
      plainJson(event.data)
      const body = json({ ...current, event: decode(WireEvent, event, "invalid_input") })
      try {
        await rpc("append", body, Receipt, signal)
      } catch (error) {
        failure = sanitize(error)
        throw failure
      }
    })

  const read = (after: number): Effect.Effect<Page> =>
    perform(async (signal) => {
      ready()
      const page = await rpc("read", json({ after: decode(Integer, after, "invalid_input"), limit: 10 }), Page, signal)
      let cursor = after
      for (const entry of page.entries) {
        if (entry.cursor <= cursor) throw new CloudHistoryError("unavailable")
        cursor = entry.cursor
      }
      if (page.cursor !== cursor || (page.hasMore && page.entries.length === 0))
        throw new CloudHistoryError("unavailable")
      return page
    })

  return { initialize, append, read }
}

function perform<A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A> {
  return Effect.tryPromise({ try: run, catch: sanitize }).pipe(Effect.orDie)
}

function sanitize(error: unknown) {
  return error instanceof CloudHistoryError ? error : new CloudHistoryError("unavailable")
}

function decode<A>(schema: Schema.Decoder<A>, value: unknown, code: keyof typeof messages = "unavailable"): A {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
  } catch {
    throw new CloudHistoryError(code)
  }
}

function json(value: unknown) {
  const bytes = encoder.encode(JSON.stringify(value))
  if (bytes.byteLength > maxRequestBytes) throw new CloudHistoryError("invalid_input")
  return bytes
}

function plainJson(value: unknown, parents = new Set<object>(), depth = 0): void {
  if (value === null || typeof value !== "object") return
  if (depth > 48 || parents.has(value)) throw new CloudHistoryError("invalid_input")
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new CloudHistoryError("invalid_input")
  }
  parents.add(value)
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new CloudHistoryError("invalid_input")
  for (const item of Object.values(value)) plainJson(item, parents, depth + 1)
  parents.delete(value)
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new CloudHistoryError("unavailable")
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxResponseBytes) throw new CloudHistoryError("unavailable")
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return decode(Schema.UnknownFromJsonString, new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } finally {
    cancel()
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}
