import { Schema } from "effect"
import { Durable } from "@mongolgpt/schema/durable-event-manifest"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { createHistoryStore, HistoryError, type HistoryEvent, type HistoryScope } from "./history"

const origin = "http://history.mongolgpt.internal"
const maxBodyBytes = 1024 * 1024 + 4096
const decoder = new TextDecoder()
const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const
const safeMessages = {
  invalid_input: "Cloud түүхийн хүсэлт буруу байна.",
  conflict: "Cloud түүхийн дараалал зөрсөн байна. Сессийг дахин ачаална уу.",
  fenced: "Cloud runtime шинэчлэгдсэн байна. Сессийг дахин ачаална уу.",
  unavailable: "Cloud түүхийг хадгалах үйлчилгээнд холбогдож чадсангүй.",
} as const
const statuses = {
  invalid_input: 400,
  conflict: 409,
  fenced: 409,
  unavailable: 503,
} as const

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const EpochInput = Schema.Struct({})
const ClaimInput = Schema.Struct({
  expectedEpoch: NonNegativeInt,
  writerID: Schema.String,
})
const EventInput = Schema.Struct({
  id: Schema.String,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: JsonObject,
})
const AppendInput = Schema.Struct({
  epoch: PositiveInt,
  writerID: Schema.String,
  event: EventInput,
})
const EraseInput = Schema.Struct({
  epoch: PositiveInt,
  writerID: Schema.String,
  id: Schema.String,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
})
const ReadInput = Schema.Struct({
  after: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt),
})
const ScopeInput = Schema.Struct({ accountID: Schema.String, workspaceID: Schema.String })

export function handleHistoryOutbound(request: Request, env: { HISTORY?: D1Database }, context: { params?: unknown }) {
  if (!env.HISTORY) return failure("unavailable", statuses.unavailable)
  try {
    const scope = decode(ScopeInput, context.params) as typeof ScopeInput.Type
    return createHistoryHandler(env.HISTORY, scope)(request)
  } catch {
    return failure("unavailable", statuses.unavailable)
  }
}

type HistoryStore = ReturnType<typeof createHistoryStore>
type HistoryStoreSource = Pick<D1Database, "prepare" | "batch"> | HistoryStore

export function createHistoryHandler(db: HistoryStoreSource, scope: HistoryScope) {
  const store = "prepare" in db ? createHistoryStore(db) : db
  const trustedScope = { ...scope }

  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST") return failure("invalid_input", 400)
      if (!isJson(request.headers.get("content-type"))) return failure("invalid_input", 400)
      const url = new URL(request.url)
      if (url.origin !== origin) return failure("invalid_input", 400)
      const input = await readJson(request)

      if (url.pathname === "/v1/epoch") {
        exact(input, [])
        decode(EpochInput, input)
        return success({ epoch: await store.epoch(trustedScope) })
      }
      if (url.pathname === "/v1/claim") {
        exact(input, ["expectedEpoch", "writerID"])
        rejectEnvelopeScopeFields(input)
        const body = decode(ClaimInput, input) as typeof ClaimInput.Type
        const lease = await store.claim(trustedScope, body)
        return success({ epoch: lease.epoch, writerID: lease.writerID })
      }
      if (url.pathname === "/v1/append") {
        exact(input, ["epoch", "writerID", "event"])
        rejectEnvelopeScopeFields(input)
        exact((input as { readonly event?: unknown }).event, ["id", "aggregateID", "seq", "type", "data"])
        const body = decode(AppendInput, input) as typeof AppendInput.Type
        const event = durableEvent(body.event)
        const lease = { ...trustedScope, epoch: body.epoch, writerID: body.writerID }
        if (event.definition.type === SessionV1.Event.Deleted.type) {
          return success(
            await store.erase(lease, { id: body.event.id, aggregateID: body.event.aggregateID, seq: body.event.seq }),
          )
        }
        return success(await store.append(lease, event.event))
      }
      if (url.pathname === "/v1/erase") {
        exact(input, ["epoch", "writerID", "id", "aggregateID", "seq"])
        rejectEnvelopeScopeFields(input)
        const body = decode(EraseInput, input) as typeof EraseInput.Type
        return success(
          await store.erase(
            { ...trustedScope, epoch: body.epoch, writerID: body.writerID },
            { id: body.id, aggregateID: body.aggregateID, seq: body.seq },
          ),
        )
      }
      if (url.pathname === "/v1/read") {
        exact(input, ["after", "limit"])
        rejectEnvelopeScopeFields(input)
        return success(await store.read(trustedScope, decode(ReadInput, input) as typeof ReadInput.Type))
      }
      return failure("invalid_input", 400)
    } catch (error) {
      if (error instanceof HistoryError) return failure(error.code, statuses[error.code])
      return failure("unavailable", statuses.unavailable)
    }
  }
}

function isJson(contentType: string | null) {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json"
}

async function readJson(request: Request) {
  if (!request.body) throw new HistoryError("invalid_input")
  const reader = request.body.getReader()
  const chunks = new Array<Uint8Array>()
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > maxBodyBytes) {
      await reader.cancel()
      throw new HistoryError("invalid_input")
    }
    chunks.push(chunk.value)
  }
  return decode(Schema.UnknownFromJsonString, decoder.decode(concat(chunks, size)))
}

function concat(chunks: Uint8Array[], size: number) {
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function durableEvent(event: HistoryEvent) {
  const definition = Durable.get(event.type)
  if (!definition?.durable) throw new HistoryError("invalid_input")
  const decoded = decode(definition.data, event.data) as Record<string, unknown>
  if (decoded[definition.durable.aggregate] !== event.aggregateID) throw new HistoryError("invalid_input")
  const encoded = encode(definition.data, decoded)
  if (!encoded || typeof encoded !== "object" || Array.isArray(encoded)) throw new HistoryError("invalid_input")
  return { definition, event: { ...event, data: encoded as Record<string, unknown> } }
}

function decode(schema: Parameters<typeof Schema.decodeUnknownSync>[0], value: unknown): unknown {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
  } catch {
    throw new HistoryError("invalid_input")
  }
}

function encode(schema: Parameters<typeof Schema.encodeUnknownSync>[0], value: unknown): unknown {
  try {
    return Schema.encodeUnknownSync(schema)(value)
  } catch {
    throw new HistoryError("invalid_input")
  }
}

function exact(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryError("invalid_input")
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new HistoryError("invalid_input")
}

function rejectEnvelopeScopeFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  if (["scope", "accountID", "workspaceID"].some((key) => Object.hasOwn(value, key))) {
    throw new HistoryError("invalid_input")
  }
}

function success(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders })
}

function failure(code: keyof typeof safeMessages, status: number) {
  return new Response(JSON.stringify({ error: { code, message: safeMessages[code] } }), {
    status,
    headers: jsonHeaders,
  })
}
