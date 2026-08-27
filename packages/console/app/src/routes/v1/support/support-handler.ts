import {
  SupportError,
  createSupportTicket,
  getAccountSupportTicket,
  listAccountSupportTickets,
  replyToSupportTicket,
} from "@mongolgpt/console-core/support.js"
import { canonicalHttpsOrigin } from "../../auth/helpers"
import { z } from "zod"
import type { AccountOverviewIdentity } from "../account/overview-handler"

const MAX_REQUEST_BYTES = 16 * 1024
const PREFLIGHT_MAX_AGE = "600"
const TicketID = z.string().regex(/^spt_[0-9A-HJKMNP-TV-Z]{26}$/)

const CreateTicket = z
  .object({
    workspaceID: z.string().trim().min(1).max(30).optional(),
    subject: z.string().trim().min(1).max(160),
    category: z.enum(["account", "billing", "technical", "feedback", "other"]),
    message: z.string().trim().min(1).max(5_000),
  })
  .strict()

const ReplyTicket = z
  .object({
    message: z.string().trim().min(1).max(5_000),
    expectedLockVersion: z.number().int().nonnegative(),
  })
  .strict()

const ListTickets = z
  .object({
    cursor: z.string().max(80).optional(),
    limit: z.enum(["25", "50"]).optional(),
  })
  .strict()

type Identity = Extract<AccountOverviewIdentity, { status: "authenticated" }>

export type SupportService = {
  create: (input: Parameters<typeof createSupportTicket>[0]) => Promise<unknown>
  list: (input: Parameters<typeof listAccountSupportTickets>[0]) => Promise<unknown>
  detail: (input: Parameters<typeof getAccountSupportTicket>[0]) => Promise<unknown>
  reply: (input: Parameters<typeof replyToSupportTicket>[0]) => Promise<unknown>
}

const service: SupportService = {
  create: createSupportTicket,
  list: listAccountSupportTickets,
  detail: getAccountSupportTicket,
  reply: replyToSupportTicket,
}

export function supportPreflight(request: Request, appUrl: string | undefined) {
  const origin = allowedOrigin(request, appUrl)
  if (!origin) return invalidOrigin()
  const headers = responseHeaders(origin)
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type")
  headers.set("Access-Control-Max-Age", PREFLIGHT_MAX_AGE)
  return new Response(null, { status: 204, headers })
}

export async function createTicketRequest(request: Request, input: HandlerInput) {
  const support = input.service ?? service
  return mutate(
    request,
    input,
    CreateTicket,
    async (identity, body) =>
      support.create({
        accountID: identity.account.id,
        requesterEmail: identity.account.email,
        workspaceID: body.workspaceID,
        subject: body.subject,
        category: body.category,
        message: body.message,
      }),
    201,
  )
}

export async function listTicketsRequest(request: Request, input: HandlerInput) {
  const support = input.service ?? service
  return read(request, input, async (identity) => {
    const query = parseQuery(request.url)
    const parsed = ListTickets.safeParse(query)
    if (!parsed.success) throw new SupportError("invalid", "Жагсаалтын хүсэлт буруу байна.")
    return support.list({
      accountID: identity.account.id,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit === "50" ? 50 : 25,
    })
  })
}

export async function ticketDetailRequest(request: Request, ticketID: string, input: HandlerInput) {
  const support = input.service ?? service
  return read(request, input, async (identity) =>
    support.detail({ accountID: identity.account.id, ticketID: ticketIDValue(ticketID) }),
  )
}

export async function replyTicketRequest(request: Request, ticketID: string, input: HandlerInput) {
  const support = input.service ?? service
  return mutate(request, input, ReplyTicket, async (identity, body) =>
    support.reply({
      accountID: identity.account.id,
      ticketID: ticketIDValue(ticketID),
      message: body.message,
      expectedLockVersion: body.expectedLockVersion,
    }),
  )
}

export type HandlerInput = {
  appUrl: string | undefined
  authenticate: (request: Request) => Promise<AccountOverviewIdentity>
  service?: SupportService
}

async function read(request: Request, input: HandlerInput, action: (identity: Identity) => Promise<unknown>) {
  const origin = browserOrigin(request, input.appUrl)
  if (origin === false) return invalidOrigin()
  const headers = responseHeaders(origin)
  const identity = await input.authenticate(request)
  if (identity.status !== "authenticated") return identityResponse(identity, headers)

  try {
    return Response.json(await action(identity), { headers })
  } catch (error) {
    return supportErrorResponse(error, headers)
  }
}

async function mutate<T extends z.ZodType>(
  request: Request,
  input: HandlerInput,
  schema: T,
  action: (identity: Identity, body: z.output<T>) => Promise<unknown>,
  successStatus = 200,
) {
  const origin = browserOrigin(request, input.appUrl)
  if (origin === false) return invalidOrigin()
  const headers = responseHeaders(origin)
  const identity = await input.authenticate(request)
  if (identity.status !== "authenticated") return identityResponse(identity, headers)
  if (!isBearerRequest(request) && !origin) return invalidOrigin()

  const body = await parseBody(request, schema)
  if (body instanceof Response) return withHeaders(body, headers)
  try {
    return Response.json(await action(identity, body), { status: successStatus, headers })
  } catch (error) {
    return supportErrorResponse(error, headers)
  }
}

function browserOrigin(request: Request, appUrl: string | undefined): string | undefined | false {
  const requestOrigin = request.headers.get("Origin")
  if (!requestOrigin) return undefined
  const appOrigin = canonicalHttpsOrigin(appUrl)
  return appOrigin && requestOrigin === appOrigin ? appOrigin : false
}

function allowedOrigin(request: Request, appUrl: string | undefined) {
  const appOrigin = canonicalHttpsOrigin(appUrl)
  return appOrigin && request.headers.get("Origin") === appOrigin ? appOrigin : undefined
}

async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T> | Response> {
  if (mediaType(request.headers.get("content-type")) !== "application/json") {
    return errorResponse("invalid", "Content-Type application/json байх ёстой.", 400)
  }
  let raw: string
  try {
    raw = await readBoundedBody(request.body, request.headers.get("content-length"), MAX_REQUEST_BYTES)
  } catch {
    return errorResponse("invalid", "Илгээсэн мэдээлэл хэт том эсвэл буруу байна.", 400)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return errorResponse("invalid", "JSON хүсэлтийн бүтэц буруу байна.", 400)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) return errorResponse("invalid", "Оруулсан мэдээлэл буруу байна.", 400)
  return parsed.data
}

function parseQuery(url: string) {
  const search = new URL(url).searchParams
  const result: Record<string, string> = {}
  for (const [key, value] of search) {
    if (key in result) throw new SupportError("invalid", "Давхар query parameter зөвшөөрөхгүй.")
    result[key] = value
  }
  return result
}

function ticketIDValue(value: string) {
  const parsed = TicketID.safeParse(value)
  if (!parsed.success) throw new SupportError("invalid", "Тусламжийн хүсэлтийн дугаар буруу байна.")
  return parsed.data
}

function identityResponse(identity: Exclude<AccountOverviewIdentity, Identity>, headers: Headers) {
  if (identity.status === "suspended") {
    return errorResponse("forbidden", "Таны MongolGPT бүртгэлийг түр түдгэлзүүлсэн байна.", 403, headers)
  }
  return errorResponse("unauthorized", "MongolGPT бүртгэлээр нэвтэрнэ үү.", 401, headers)
}

function supportErrorResponse(error: unknown, headers: Headers) {
  if (!(error instanceof SupportError)) return errorResponse("internal", "Серверийн алдаа гарлаа.", 500, headers)
  const mapped = {
    invalid: [400, "Оруулсан мэдээлэл буруу байна."],
    forbidden: [403, "Энэ үйлдэлд хандах эрхгүй байна."],
    suspended: [403, "Таны MongolGPT бүртгэлийг түр түдгэлзүүлсэн байна."],
    membership: [403, "Энэ ажлын орон зайд хандах эрхгүй байна."],
    not_found: [404, "Тусламжийн хүсэлт олдсонгүй."],
    closed: [409, "Хаагдсан хүсэлтэд хариу нэмэх боломжгүй."],
    conflict: [409, "Хүсэлт өөрчлөгдсөн байна. Дахин ачаална уу."],
    rate_limit: [429, "Хүсэлтийн хязгаарт хүрсэн байна. Дараа дахин оролдоно уу."],
  } as const
  const [status, message] = mapped[error.code]
  return errorResponse(error.code, message, status, headers)
}

function errorResponse(error: string, message: string, status: number, headers = responseHeaders()) {
  return Response.json({ error, message }, { status, headers })
}

function responseHeaders(origin?: string) {
  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" })
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin)
    headers.set("Access-Control-Allow-Credentials", "true")
  }
  return headers
}

function invalidOrigin() {
  return errorResponse("forbidden", "Энэ хүсэлтийн гарал зөвшөөрөгдөөгүй байна.", 403)
}

function withHeaders(response: Response, headers: Headers) {
  for (const [key, value] of headers) response.headers.set(key, value)
  return response
}

function mediaType(value: string | null) {
  return value?.split(";", 1)[0]?.trim().toLowerCase()
}

function isBearerRequest(request: Request) {
  return /^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")
}

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, contentLength: string | null, limit: number) {
  const declared = contentLength === null ? undefined : Number(contentLength)
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > limit)) {
    throw new Error("body_size_invalid")
  }
  if (!body) return ""
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (size > limit - chunk.value.byteLength) throw new Error("body_too_large")
      size += chunk.value.byteLength
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  }
  const value = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    value.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(value)
}
