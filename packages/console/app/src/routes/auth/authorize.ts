import type { APIEvent } from "@solidjs/start/server"
import {
  readTurnstileAuthorizationParameters,
  turnstileAuthorizationRequest,
} from "@mongolgpt/console-core/turnstile.js"
import { AuthClient } from "~/context/auth"
import { configuredConsoleRequestUrl, safeAuthContinue } from "./helpers"
import { renderTurnstileChallenge } from "./turnstile"

export async function GET(input: APIEvent) {
  const url = configuredConsoleRequestUrl(input.request.url, import.meta.env.MONGOLGPT_CONSOLE_URL)
  if (!url) return invalidAuthorizationRequest()
  const cont = safeAuthContinue(url.searchParams.get("continue"))
  const clientID = url.searchParams.get("client_id")
  if (clientID && clientID !== "mongolgpt-cli") return invalidAuthorizationRequest()
  let target: string
  try {
    target = clientID === "mongolgpt-cli" ? cliAuthorizationTarget(url) : await authorizationTarget(url, cont)
  } catch {
    return invalidAuthorizationRequest()
  }
  if (!turnstileEnabled()) return Response.redirect(target, 302)

  return challengeResponse(target, turnstileError(url.searchParams.get("turnstile_error")))
}

function invalidAuthorizationRequest() {
  return Response.json(
    { error: "invalid_authorization_request", message: "Нэвтрэх хүсэлт буруу байна." },
    { status: 400, headers: { "cache-control": "no-store" } },
  )
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

async function authorizationTarget(requestUrl: URL, cont: string) {
  const callbackUrl = new URL(`./callback${cont}`, requestUrl)
  const result = await AuthClient.authorize(callbackUrl.toString(), "code")
  return result.url
}

function turnstileEnabled() {
  return import.meta.env.MONGOLGPT_TURNSTILE_ENABLED === "true"
}

function challengeResponse(authorizationUrl: string, error?: "invalid" | "unavailable" | "misconfigured") {
  const siteKey = import.meta.env.MONGOLGPT_TURNSTILE_SITE_KEY?.trim() ?? ""
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
