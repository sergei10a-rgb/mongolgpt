import type { APIEvent } from "@solidjs/start/server"
import {
  readTurnstileAuthorizationParameters,
  turnstileAuthorizationRequest,
} from "@mongolgpt/console-core/turnstile.js"
import { hostedConsoleUrl, hostedTurnstileEnabled, hostedTurnstileSiteKey } from "~/lib/hosted-env"
import { authorizationTarget, type OAuthAuthorizationStage } from "./authorization-target"
import { configuredAppUrl, configuredConsoleRequestUrl, safeAuthContinue } from "./helpers"
import { renderTurnstileChallenge } from "./turnstile"

const OAUTH_PROVIDER_FORM_ACTION_ORIGINS = ["https://github.com", "https://accounts.google.com"] as const

export async function GET(input: APIEvent) {
  const url = configuredConsoleRequestUrl(input.request.url, hostedConsoleUrl)
  if (!url) return invalidAuthorizationRequest(authorizationOriginFailure(input.request.url, hostedConsoleUrl))
  const cont = safeAuthContinue(url.searchParams.get("continue"))
  const clientID = url.searchParams.get("client_id")
  if (clientID && clientID !== "mongolgpt-cli") return invalidAuthorizationRequest("cli_request")
  let target: string
  let failureStage: OAuthAuthorizationStage = "authorization_target"
  try {
    target =
      clientID === "mongolgpt-cli"
        ? cliAuthorizationTarget(url)
        : await authorizationTarget(url, cont, {
            onStage: (stage) => {
              failureStage = stage
            },
          })
  } catch (error) {
    if (!clientID) {
      console.error("MongolGPT OAuth authorization target үүссэнгүй", failureStage, errorName(error))
      return authorizationServiceUnavailable(failureStage)
    }
    return invalidAuthorizationRequest("cli_request")
  }
  if (!turnstileEnabled()) return Response.redirect(target, 302)

  return challengeResponse(target, url.origin, turnstileError(url.searchParams.get("turnstile_error")))
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

function turnstileEnabled() {
  return hostedTurnstileEnabled
}

function challengeResponse(
  authorizationUrl: string,
  consoleOrigin: string,
  error?: "invalid" | "unavailable" | "misconfigured",
) {
  const siteKey = hostedTurnstileSiteKey
  if (!siteKey) {
    return Response.json(
      { error: "turnstile_not_configured", message: "Нэвтрэх хамгаалалтын тохиргоо дутуу байна." },
      { status: 503, headers: { "cache-control": "no-store" } },
    )
  }
  try {
    const scriptNonce = crypto.randomUUID().replaceAll("-", "")
    const challenge = renderTurnstileChallenge({ siteKey, scriptNonce, authorizationUrl, consoleOrigin, error })
    const formActionOrigins = [
      ...new Set([challenge.authOrigin, ...OAUTH_PROVIDER_FORM_ACTION_ORIGINS, challenge.callbackOrigin]),
    ]
    return new Response(challenge.html, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${scriptNonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'unsafe-inline'; form-action ${formActionOrigins.join(" ")}; base-uri 'none'; object-src 'none'`,
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
