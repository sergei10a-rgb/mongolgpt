import { z } from "zod"

const CLI_CLIENT_ID = "mongolgpt-cli"
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_TOKEN_LENGTH = 16 * 1024

const TokenRequest = z
  .object({
    grant_type: z.string().trim().min(1).max(64),
    refresh_token: z.string().trim().min(1).max(MAX_TOKEN_LENGTH),
    client_id: z.string().trim().min(1).max(128),
  })
  .strict()

const TokenSuccess = z.object({
  access_token: z.string().trim().min(1).max(MAX_TOKEN_LENGTH),
  refresh_token: z.string().trim().min(1).max(MAX_TOKEN_LENGTH),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(365 * 24 * 60 * 60),
  token_type: z.literal("Bearer").optional(),
})

const TokenError = z.object({
  error: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/),
  error_description: z.string().trim().min(1).max(512).optional(),
})

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function refreshCliToken(
  request: Request,
  input: {
    tokenEndpoint: string
    verifyToken: (token: string) => Promise<unknown>
    fetcher?: Fetcher
  },
) {
  if (mediaType(request.headers.get("content-type")) !== "application/json") {
    return oauthError("invalid_request", "Content-Type application/json шаардлагатай", 415)
  }

  let raw: string
  try {
    raw = await readBoundedBody(request.body, request.headers.get("content-length"), MAX_REQUEST_BYTES)
  } catch {
    return oauthError("invalid_request", "JSON request body хэт том эсвэл буруу байна", 400)
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return oauthError("invalid_request", "JSON request body шаардлагатай", 400)
  }

  const body = TokenRequest.safeParse(value)
  if (!body.success) return oauthError("invalid_request", "Refresh token хүсэлтийн бүтэц буруу байна", 400)
  if (body.data.grant_type !== "refresh_token") {
    return oauthError(
      "unsupported_grant_type",
      "MongolGPT CLI эхний нэвтрэлтэд browser OAuth ашигладаг. Энэ endpoint зөвхөн хадгалсан token шинэчилнэ.",
      400,
    )
  }
  if (body.data.client_id !== CLI_CLIENT_ID) {
    return oauthError("invalid_client", "MongolGPT CLI client_id буруу байна", 400)
  }

  let response: Response
  try {
    response = await (input.fetcher ?? fetch)(input.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: body.data.refresh_token,
        client_id: CLI_CLIENT_ID,
      }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return oauthError("temporarily_unavailable", "Нэвтрэх token үйлчилгээ түр хариу өгөхгүй байна", 503)
  }

  let text: string
  try {
    text = await readBoundedBody(response.body, response.headers.get("content-length"), MAX_RESPONSE_BYTES)
  } catch {
    return oauthError("server_error", "Нэвтрэх token үйлчилгээ буруу хариу өглөө", 502)
  }
  if (mediaType(response.headers.get("content-type")) !== "application/json") {
    return oauthError("server_error", "Нэвтрэх token үйлчилгээ JSON хариу өгсөнгүй", 502)
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return oauthError("server_error", "Нэвтрэх token үйлчилгээ буруу JSON хариу өглөө", 502)
  }

  if (!response.ok) {
    const parsed = TokenError.safeParse(payload)
    if (!parsed.success) return oauthError("server_error", "Нэвтрэх token үйлчилгээ буруу хариу өглөө", 502)
    return oauthError(
      parsed.data.error,
      parsed.data.error_description ?? "Нэвтрэх token хүсэлт амжилтгүй боллоо",
      response.status >= 400 && response.status < 500 ? response.status : 502,
    )
  }

  const parsed = TokenSuccess.safeParse(payload)
  if (!parsed.success) return oauthError("server_error", "Нэвтрэх token үйлчилгээний хариу дутуу байна", 502)

  let verified: unknown
  try {
    verified = await input.verifyToken(parsed.data.access_token)
  } catch {
    return oauthError("temporarily_unavailable", "Аккаунтын эрхийг одоогоор шалгаж чадсангүй", 503)
  }
  if (!verified) {
    return oauthError(
      "invalid_grant",
      "Нэвтрэх эрх хүчингүй болсон. MongolGPT-д browser OAuth-оор дахин нэвтэрнэ үү.",
      400,
    )
  }

  return Response.json(
    {
      access_token: parsed.data.access_token,
      refresh_token: parsed.data.refresh_token,
      expires_in: parsed.data.expires_in,
      ...(parsed.data.token_type ? { token_type: parsed.data.token_type } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
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

function mediaType(value: string | null) {
  return value?.split(";", 1)[0]?.trim().toLowerCase()
}

function oauthError(error: string, error_description: string, status: number) {
  return Response.json({ error, error_description }, { status, headers: { "Cache-Control": "no-store" } })
}
