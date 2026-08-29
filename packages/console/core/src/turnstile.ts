import { z } from "zod"

export const TURNSTILE_ACTION = "mongolgpt_login"
export const TURNSTILE_RESPONSE_FIELD = "mongolgpt-turnstile-response"
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA"
export const TURNSTILE_TEST_SECRET_KEY = "1x0000000000000000000000000000000AA"
export const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
const MAX_TOKEN_LENGTH = 2_048
const MAX_FORM_LENGTH = 16_384
const VERIFY_TIMEOUT_MS = 4_000

const SiteverifyResponseSchema = z
  .object({
    success: z.boolean(),
    hostname: z.string().optional(),
    action: z.string().optional(),
    "error-codes": z.array(z.string()).optional(),
  })
  .passthrough()

export type TurnstileVerification =
  | { ok: true }
  | { ok: false; reason: "invalid" | "misconfigured" | "provider_unavailable" }

export type TurnstileAuthorizationParameters = {
  clientID: string
  redirectURI: string
  responseType: string
  state: string
  codeChallenge?: string
  codeChallengeMethod?: string
}

export type TurnstileAuthorizationSubmission = TurnstileAuthorizationParameters & { token: string }

type TurnstileFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function verifyTurnstile(input: {
  token: string
  secret: string
  expectedHostname: string
  remoteIp?: string
  fetcher?: TurnstileFetch
}): Promise<TurnstileVerification> {
  const token = input.token.trim()
  const secret = input.secret.trim()
  const expectedHostname = input.expectedHostname.trim().toLowerCase().replace(/\.$/, "")
  if (!secret || secret === "disabled" || !expectedHostname) return { ok: false, reason: "misconfigured" }
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "invalid" }

  const body = new URLSearchParams({
    secret,
    response: token,
    idempotency_key: crypto.randomUUID(),
  })
  const remoteIp = normalizedRemoteIp(input.remoteIp)
  if (remoteIp) body.set("remoteip", remoteIp)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)
  try {
    const response = await (input.fetcher ?? fetch)(SITEVERIFY_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: "provider_unavailable" }

    const raw = await response.text()
    if (raw.length > 16_384) return { ok: false, reason: "provider_unavailable" }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, reason: "provider_unavailable" }
    }

    const result = SiteverifyResponseSchema.safeParse(parsed)
    if (!result.success) return { ok: false, reason: "provider_unavailable" }
    if (!result.data.success) return { ok: false, reason: "invalid" }
    const testMode = secret === TURNSTILE_TEST_SECRET_KEY
    if (!testMode && result.data.action !== TURNSTILE_ACTION) return { ok: false, reason: "invalid" }
    if (!testMode && result.data.hostname?.toLowerCase().replace(/\.$/, "") !== expectedHostname) {
      return { ok: false, reason: "invalid" }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: "provider_unavailable" }
  } finally {
    clearTimeout(timeout)
  }
}

export async function readTurnstileAuthorizationSubmission(
  request: Request,
): Promise<TurnstileAuthorizationSubmission | undefined> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/x-www-form-urlencoded") return undefined
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_LENGTH) return undefined

  const raw = await request.text()
  if (raw.length > MAX_FORM_LENGTH) return undefined
  const form = new URLSearchParams(raw)
  const token = singleValue(form, TURNSTILE_RESPONSE_FIELD, MAX_TOKEN_LENGTH)
  const parameters = readTurnstileAuthorizationParameters(form)
  if (!token || !parameters) return undefined
  return { token, ...parameters } satisfies TurnstileAuthorizationSubmission
}

export function readTurnstileAuthorizationParameters(
  form: URLSearchParams,
): TurnstileAuthorizationParameters | undefined {
  const clientID = singleValue(form, "client_id", 128)
  const redirectURI = singleValue(form, "redirect_uri", 2_048)
  const responseType = singleValue(form, "response_type", 32)
  const state = singleValue(form, "state", 256)
  const codeChallenge = optionalSingleValue(form, "code_challenge", 128)
  const codeChallengeMethod = optionalSingleValue(form, "code_challenge_method", 16)
  if (!clientID || !redirectURI || !responseType || !state || !codeChallenge.valid || !codeChallengeMethod.valid) {
    return undefined
  }
  return {
    clientID,
    redirectURI,
    responseType,
    state,
    codeChallenge: codeChallenge.value,
    codeChallengeMethod: codeChallengeMethod.value,
  } satisfies TurnstileAuthorizationParameters
}

export function turnstileAuthorizationRequest(input: {
  authUrl: string
  consoleOrigin: string
  submission: TurnstileAuthorizationSubmission
}) {
  const auth = cleanOrigin(input.authUrl, true)
  if (!validAuthorizePath(auth) || auth.search || auth.hash) throw new Error("Invalid auth URL")
  const consoleOrigin = cleanOrigin(input.consoleOrigin)
  const callback = new URL(input.submission.redirectURI)
  if (callback.username || callback.password || callback.hash) throw new Error("Invalid OAuth callback")
  if (input.submission.responseType !== "code") throw new Error("Invalid OAuth client")
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(input.submission.state)) throw new Error("Invalid OAuth state")

  if (input.submission.clientID === "app") {
    if (
      callback.origin !== consoleOrigin.origin ||
      (callback.pathname !== "/auth/callback" && !callback.pathname.startsWith("/auth/callback/")) ||
      input.submission.codeChallenge ||
      input.submission.codeChallengeMethod
    ) {
      throw new Error("Invalid OAuth callback")
    }
  } else if (input.submission.clientID === "mongolgpt-cli") {
    if (
      !validCliLoopbackCallback(callback) ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(input.submission.codeChallenge ?? "") ||
      input.submission.codeChallengeMethod !== "S256"
    ) {
      throw new Error("Invalid OAuth CLI request")
    }
  } else {
    throw new Error("Invalid OAuth client")
  }

  const query = new URLSearchParams({
    client_id: input.submission.clientID,
    redirect_uri: callback.toString(),
    response_type: input.submission.responseType,
    state: input.submission.state,
  })
  if (input.submission.codeChallenge) query.set("code_challenge", input.submission.codeChallenge)
  if (input.submission.codeChallengeMethod) query.set("code_challenge_method", input.submission.codeChallengeMethod)
  auth.search = query.toString()
  return auth
}

export function turnstileRetryUrl(input: {
  consoleOrigin: string
  submission: TurnstileAuthorizationSubmission
  reason: "invalid" | "misconfigured" | "provider_unavailable"
}) {
  const consoleOrigin = cleanOrigin(input.consoleOrigin)
  const callback = new URL(input.submission.redirectURI)
  const retry = new URL("/auth/authorize", consoleOrigin)
  if (input.submission.clientID === "app") {
    if (callback.origin !== consoleOrigin.origin) throw new Error("Invalid OAuth callback")
    const suffix = callback.pathname.replace(/^\/auth\/callback/, "") || "/auth"
    retry.searchParams.set("continue", `${suffix}${callback.search}`)
  } else if (input.submission.clientID === "mongolgpt-cli") {
    retry.search = authorizationParameters(input.submission).toString()
  } else {
    throw new Error("Invalid OAuth client")
  }
  retry.searchParams.set("turnstile_error", input.reason)
  return retry
}

function cleanOrigin(value: string, allowAuthorizePath = false) {
  const url = new URL(value)
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    (!allowAuthorizePath && (url.pathname !== "/" || url.search || url.hash))
  ) {
    throw new Error("Invalid origin")
  }
  return url
}

function validAuthorizePath(url: URL) {
  if (url.pathname === "/authorize") return true
  return isLoopback(url) && url.pathname === "/auth/authorize"
}

function isLoopback(url: URL) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
}

function validCliLoopbackCallback(url: URL) {
  if (url.protocol !== "http:" || (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) return false
  if (url.pathname !== "/auth/callback" || url.search || url.hash) return false
  const port = Number(url.port)
  return Number.isInteger(port) && port >= 1_024 && port <= 65_535
}

function authorizationParameters(input: TurnstileAuthorizationParameters) {
  const result = new URLSearchParams({
    client_id: input.clientID,
    redirect_uri: input.redirectURI,
    response_type: input.responseType,
    state: input.state,
  })
  if (input.codeChallenge) result.set("code_challenge", input.codeChallenge)
  if (input.codeChallengeMethod) result.set("code_challenge_method", input.codeChallengeMethod)
  return result
}

function singleValue(form: URLSearchParams, name: string, maximum: number) {
  const values = form.getAll(name)
  if (values.length !== 1) return undefined
  const value = values[0]?.trim()
  if (!value || value.length > maximum) return undefined
  return value
}

function optionalSingleValue(form: URLSearchParams, name: string, maximum: number) {
  const values = form.getAll(name)
  if (values.length === 0) return { valid: true as const, value: undefined }
  if (values.length !== 1) return { valid: false as const, value: undefined }
  const value = values[0]?.trim()
  if (!value || value.length > maximum) return { valid: false as const, value: undefined }
  return { valid: true as const, value }
}

function normalizedRemoteIp(value: string | undefined) {
  const ip = value?.trim()
  if (!ip || ip.length > 64 || /\s/.test(ip)) return undefined
  return ip
}
