import type { APIEvent } from "@solidjs/start/server"
import {
  readTurnstileAuthorizationParameters,
  turnstileAuthorizationRequest,
} from "@mongolgpt/console-core/turnstile.js"
import { AuthClient } from "~/context/auth"
import { hostedConsoleUrl, hostedTurnstileEnabled, hostedTurnstileSiteKey } from "~/lib/hosted-env"
import { configuredAppUrl, configuredConsoleRequestUrl, safeAuthContinue } from "./helpers"
import { issueOAuthState, type OAuthStateSessionData, useOAuthStateSession } from "./oauth-state"
import { renderTurnstileChallenge } from "./turnstile"

export async function GET(input: APIEvent) {
  const url = configuredConsoleRequestUrl(input.request.url, hostedConsoleUrl)
  if (!url) return invalidAuthorizationRequest(authorizationOriginFailure(input.request.url, hostedConsoleUrl))
  const cont = safeAuthContinue(url.searchParams.get("continue"))
  const clientID = url.searchParams.get("client_id")
  if (clientID && clientID !== "mongolgpt-cli") return invalidAuthorizationRequest("cli_request")
  let target: string
  try {
    target = clientID === "mongolgpt-cli" ? cliAuthorizationTarget(url) : await authorizationTarget(url, cont)
  } catch (error) {
    if (error instanceof OAuthAuthorizationTargetError) {
      console.error("MongolGPT OAuth authorization target үүссэнгүй", error.stage, error.causeName)
      return authorizationServiceUnavailable(error.stage)
    }
    if (!clientID) {
      console.error("MongolGPT OAuth authorization target үүссэнгүй", "authorization_target", errorName(error))
      return authorizationServiceUnavailable("authorization_target")
    }
    return invalidAuthorizationRequest("cli_request")
  }
  if (!turnstileEnabled()) return Response.redirect(target, 302)

  return challengeResponse(target, turnstileError(url.searchParams.get("turnstile_error")))
}

type OAuthAuthorizationStage =
  | "authorization_target"
  | "state_session"
  | "authorization_url"
  | "state_issue"
  | "state_store"

class OAuthAuthorizationTargetError extends Error {
  readonly causeName: string

  constructor(
    readonly stage: OAuthAuthorizationStage,
    cause: unknown,
  ) {
    super(`OAuth authorization target failed at ${stage}`)
    this.name = "OAuthAuthorizationTargetError"
    this.causeName = cause instanceof Error ? cause.name : typeof cause
  }
}

function authorizationServiceUnavailable(stage: OAuthAuthorizationStage) {
  return Response.json(
    {
      error: "oauth_authorization_unavailable",
      stage,
      message: "Нэвтрэх үйлчилгээг түр эхлүүлж чадсангүй. Түр хүлээгээд дахин оролдоно уу.",
    },
    { status: 503, headers: { "cache-control": "no-store", "retry-after": "30" } },
  )
}

type InvalidAuthorizationStage = "request_url" | "console_url" | "origin_mismatch" | "cli_request"

function invalidAuthorizationRequest(stage: InvalidAuthorizationStage) {
  return Response.json(
    { error: "invalid_authorization_request", stage, message: "Нэвтрэх хүсэлт буруу байна." },
    { status: 400, headers: { "cache-control": "no-store" } },
  )
}

function authorizationOriginFailure(
  requestUrl: string,
  configuredConsoleUrl: string | undefined,
): Exclude<InvalidAuthorizationStage, "cli_request"> {
  let request: URL
  try {
    request = new URL(requestUrl)
  } catch {
    return "request_url"
  }
  const configured = configuredAppUrl(configuredConsoleUrl)
  if (!configured) return "console_url"
  if (request.origin !== configured.origin) return "origin_mismatch"
  return "request_url"
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error
}

function cliAuthorizationTarget(url: URL) {
  const parameters = readTurnstileAuthorizationParameters(url.searchParams)
  if (!parameters || parameters.clientID !== "mongolgpt-cli") throw new Error("Invalid CLI authorization request")
  const issuer = import.meta.env.VITE_AUTH_URL?.trim()
  if (!issuer) throw new Error("Missing auth issuer")
  return turnstileAuthorizationRequest({
    authUrl: `${issuer.replace(/\/+$/, "")}/authorize`,
    consoleOrigin: url.origin,
    submission: { token: "browser-challenge", ...parameters },
  }).toString()
}

export async function authorizationTarget(
  requestUrl: URL,
  cont: string,
  dependencies: {
    authorize?: (redirectURI: string, response: "code" | "token") => Promise<{ url: string }>
    stateSession?: () => Promise<{
      update(updater: (value: OAuthStateSessionData) => OAuthStateSessionData): Promise<unknown>
    }>
  } = {},
) {
  const callbackUrl = new URL(`./callback${cont}`, requestUrl)
  const authorize = dependencies.authorize ?? ((...input) => AuthClient.authorize(...input))
  const session = await stage("state_session", () => (dependencies.stateSession ?? useOAuthStateSession)())
  const result = await stage("authorization_url", () => authorize(callbackUrl.toString(), "code"))
  const issued = await stage("state_issue", () => issueOAuthState(result.url))
  await stage("state_store", () => session.update(() => issued.session))
  return issued.authorizationUrl
}

async function stage<T>(name: OAuthAuthorizationStage, operation: () => T | Promise<T>) {
  try {
    return await operation()
  } catch (error) {
    throw new OAuthAuthorizationTargetError(name, error)
  }
}

function turnstileEnabled() {
  return hostedTurnstileEnabled
}

function challengeResponse(authorizationUrl: string, error?: "invalid" | "unavailable" | "misconfigured") {
  const siteKey = hostedTurnstileSiteKey
  if (!siteKey) {
    return Response.json(
      { error: "turnstile_not_configured", message: "Нэвтрэх хамгаалалтын тохиргоо дутуу байна." },
      { status: 503, headers: { "cache-control": "no-store" } },
    )
  }
  try {
    const challenge = renderTurnstileChallenge({ siteKey, authorizationUrl, error })
    return new Response(challenge.html, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; form-action ${challenge.authOrigin}; base-uri 'none'; object-src 'none'`,
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    })
  } catch {
    return Response.json(
      { error: "turnstile_not_configured", message: "Нэвтрэх хамгаалалтын тохиргоо буруу байна." },
      { status: 503, headers: { "cache-control": "no-store" } },
    )
  }
}

function turnstileError(value: string | null): "invalid" | "unavailable" | "misconfigured" | undefined {
  if (value === "invalid") return "invalid"
  if (value === "provider_unavailable") return "unavailable"
  if (value === "misconfigured") return "misconfigured"
  return undefined
}
