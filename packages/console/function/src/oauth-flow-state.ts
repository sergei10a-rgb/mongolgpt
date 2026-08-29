import { z } from "zod"

const FLOW_TTL_SECONDS = 10 * 60
const MAX_FLOW_COOKIE_VALUE_LENGTH = 3_800
const OAUTH_PROVIDER_PATH = /^\/(github|google)\/(authorize|callback)$/
const OAuthFlowRecord = z
  .object({
    authorization: z.string().min(1).max(16 * 1024),
    provider: z.string().min(1).max(16 * 1024),
  })
  .strict()

export type RestoredOAuthFlow = {
  request: Request
  cleanupCookie?: string
}

export function restoreOAuthFlowRequest(request: Request): RestoredOAuthFlow {
  const route = oauthRoute(request)
  if (!route || route.action !== "callback") return { request }

  const state = oauthState(new URL(request.url).searchParams.get("state"))
  if (!state) return { request }

  const cleanupCookie = flowCookieName(route.provider, state)
  const raw = readCookie(request.headers.get("cookie"), cleanupCookie)
  if (!raw) return { request }

  const record = decodeFlowRecord(raw)
  if (!record) return { request, cleanupCookie }

  const headers = new Headers(request.headers)
  headers.set(
    "cookie",
    writeCookies(headers.get("cookie"), {
      authorization: record.authorization,
      provider: record.provider,
    }),
  )
  return {
    request: new Request(request, { headers }),
    cleanupCookie,
  }
}

export function captureOAuthFlow(request: Request, response: Response): Response {
  const route = oauthRoute(request)
  if (!route || route.action !== "authorize" || response.status < 300 || response.status >= 400) return response

  const location = response.headers.get("location")
  if (!location) return response

  let state: string | undefined
  try {
    const target = new URL(location, request.url)
    if (target.protocol !== "https:") return response
    state = oauthState(target.searchParams.get("state"))
  } catch {
    return response
  }
  if (!state) return response

  const authorization = readCookie(request.headers.get("cookie"), "authorization")
  const provider = readSetCookie(response.headers, "provider")
  const record = OAuthFlowRecord.safeParse({ authorization, provider })
  if (!record.success) return response
  const value = encodeFlowRecord(record.data)
  if (value.length > MAX_FLOW_COOKIE_VALUE_LENGTH) return response

  return withSetCookie(
    response,
    serializeFlowCookie(flowCookieName(route.provider, state), value, FLOW_TTL_SECONDS),
  )
}

export function clearOAuthFlowCookie(response: Response, name: string) {
  return withSetCookie(response, serializeFlowCookie(name, "", 0))
}

function oauthRoute(request: Request) {
  if (request.method !== "GET") return undefined
  const match = OAUTH_PROVIDER_PATH.exec(new URL(request.url).pathname)
  if (!match) return undefined
  return {
    provider: match[1] as "github" | "google",
    action: match[2] as "authorize" | "callback",
  }
}

function oauthState(value: string | null) {
  if (!value || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  return value
}

function flowCookieName(provider: "github" | "google", state: string) {
  return `__Host-mongolgpt-oauth-${provider}-${state}`
}

function encodeFlowRecord(record: z.infer<typeof OAuthFlowRecord>) {
  return btoa(JSON.stringify(record)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function decodeFlowRecord(value: string) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
    const parsed = OAuthFlowRecord.safeParse(JSON.parse(atob(base64)))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function readCookie(header: string | null, name: string) {
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=")
    if (key === name) return value.join("=") || undefined
  }
  return undefined
}

function writeCookies(header: string | null, values: Record<string, string>) {
  const cookies = new Map<string, string>()
  if (header) {
    for (const part of header.split(";")) {
      const [key, ...value] = part.trim().split("=")
      if (key && value.length > 0) cookies.set(key, value.join("="))
    }
  }
  for (const [key, value] of Object.entries(values)) cookies.set(key, value)
  return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ")
}

function readSetCookie(headers: Headers, name: string) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values = getSetCookie ? getSetCookie.call(headers) : [headers.get("set-cookie") ?? ""]
  const pattern = new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`)
  for (const value of values) {
    const match = pattern.exec(value)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function serializeFlowCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=None`
}

function withSetCookie(response: Response, cookie: string) {
  const headers = new Headers(response.headers)
  headers.append("set-cookie", cookie)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
