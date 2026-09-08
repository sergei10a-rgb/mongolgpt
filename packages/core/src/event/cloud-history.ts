import { Effect, Schema } from "effect"
import { Event } from "@mongolgpt/schema/event"
import { SessionEvent } from "@mongolgpt/schema/session-event"
import type { EventV2 } from "../event"
import { RuntimeControl } from "../runtime-control"

const base = "http://history.mongolgpt.internal/v1"
const maxRequestBytes = 1024 * 1024 + 4096
const maxResponseBytes = 11 * 1024 * 1024
const encoder = new TextEncoder()
const fileBoundaries = new Set(
  [
    SessionEvent.Tool.Progress,
    SessionEvent.Tool.Success,
    SessionEvent.Tool.Failed,
    SessionEvent.Step.Ended,
    SessionEvent.Step.Failed,
  ].map((event) => `${event.type}.${event.durable!.version}`),
)
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
type Workspace = Pick<RuntimeControl.Client, "register" | "publish"> & Partial<Pick<RuntimeControl.Client, "prepare">>

const Failure = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals(["invalid_input", "conflict", "fenced", "unavailable"]),
    message: Schema.String,
  }),
})
const statuses = { invalid_input: 400, conflict: 409, fenced: 409, unavailable: 503 } as const

export function createCloudHistory(
  options: {
    readonly request?: (request: Request) => Promise<Response>
    readonly checkpointID?: string
    readonly filesRevisionID?: string
    readonly expectedEpoch?: number
    readonly pendingClaim?: RuntimeControl.Claim
    readonly workspace?: Workspace
  } = {},
) {
  const request = options.request ?? ((request: Request) => fetch(request))
  const checkpointID =
    options.checkpointID === undefined ? undefined : decode(Identifier, options.checkpointID, "invalid_input")
  const filesRevisionID =
    options.filesRevisionID === undefined ? undefined : decode(Identifier, options.filesRevisionID, "invalid_input")
  const expectedEpoch =
    options.expectedEpoch === undefined
      ? undefined
      : decode(Integer.check(Schema.isLessThan(Number.MAX_SAFE_INTEGER)), options.expectedEpoch, "invalid_input")
  const workspace = options.workspace
  const pendingClaim =
    options.pendingClaim === undefined
      ? undefined
      : decode(RuntimeControl.Claim, { ...options.pendingClaim }, "invalid_input")
  if (pendingClaim && expectedEpoch !== undefined && expectedEpoch !== pendingClaim.expectedEpoch)
    throw new CloudHistoryError("fenced")
  if (pendingClaim && !workspace?.prepare) throw new CloudHistoryError("invalid_input")
  const writerID = pendingClaim ? undefined : crypto.randomUUID()
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
        const claim = pendingClaim ?? (await newClaim(signal))
        await workspace?.prepare?.({ ...claim }, signal)
        const claimed = await rpc("claim", json({ ...claim, checkpointID, filesRevisionID }), Lease, signal)
        if (claimed.epoch !== claim.expectedEpoch + 1 || claimed.writerID !== claim.writerID)
          throw new CloudHistoryError("fenced")
        await workspace?.register({ ...claimed }, signal)
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
        if (fileBoundaries.has(event.type)) await workspace?.publish(signal)
        await rpc("append", body, Receipt, signal)
      } catch (error) {
        failure = sanitize(error)
        throw failure
      }
    })

  const read = (after: number): Effect.Effect<Page> =>
    perform(async (signal) => {
      ready()
      const page = await rpc(
        "read",
        json({ after: decode(Integer, after, "invalid_input"), limit: 10, checkpointID }),
        Page,
        signal,
      )
      let cursor = after
      for (const entry of page.entries) {
        if (entry.cursor <= cursor) throw new CloudHistoryError("unavailable")
        cursor = entry.cursor
      }
      if (page.cursor !== cursor || (page.hasMore && page.entries.length === 0))
        throw new CloudHistoryError("unavailable")
      return page
    })

  const afterCommit = (event: EventV2.SerializedEvent, nativeCommit: boolean): Effect.Effect<void> => {
    const capture = nativeCommit || fileBoundaries.has(event.type)
    return perform(async (signal) => {
      ready()
      if (!capture || !workspace) return
      try {
        // Pre-append capture protects the remote tool result. This second
        // receipt includes the now-committed native state and private commit hook.
        await workspace.publish(signal)
      } catch (error) {
        failure = sanitize(error)
        throw failure
      }
    })
  }

  return { initialize, append, afterCommit, read, checkpointID }

  async function newClaim(signal: AbortSignal) {
    const expected = await rpc("epoch", json({}), Epoch, signal)
    if (expectedEpoch !== undefined && expected.epoch !== expectedEpoch) throw new CloudHistoryError("fenced")
    if (expected.epoch === Number.MAX_SAFE_INTEGER || !writerID) throw new CloudHistoryError("unavailable")
    return { expectedEpoch: expected.epoch, writerID }
  }
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
