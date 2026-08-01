import { issueRuntimeCapability } from "@mongolgpt/runtime-auth"
import { canonicalHttpsOrigin, currentAuthAccount } from "./helpers"

const TTL_SECONDS = 90
const PREFLIGHT_MAX_AGE = "600"

export function runtimeTokenPreflight(request: Request, appUrl: string | undefined) {
  const appOrigin = canonicalHttpsOrigin(appUrl)
  const origin = requestOrigin(request, appOrigin)
  if (!origin) return invalidOriginResponse()

  const headers = corsHeaders(origin, true)
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS")
  headers.set("Access-Control-Allow-Headers", "Content-Type")
  headers.set("Access-Control-Max-Age", PREFLIGHT_MAX_AGE)
  return new Response(null, { status: 204, headers })
}

export async function runtimeTokenRequest(
  request: Request,
  input: {
    appUrl: string | undefined
    runtimeUrl: string | undefined
    secret: string
    session: () => Promise<{
      data: {
        account?: Record<string, { id: string; email: string; authVersion?: number }>
        current?: string
      }
      suspended: boolean
    }>
    now?: () => number
  },
) {
  const appOrigin = canonicalHttpsOrigin(input.appUrl)
  const origin = requestOrigin(request, appOrigin)
  if (!origin) return invalidOriginResponse()

  const headers = corsHeaders(origin, true)
  const runtimeAudience = canonicalHttpsOrigin(input.runtimeUrl)
  if (!runtimeAudience) {
    return Response.json(
      { error: "runtime_not_configured", message: "MongolGPT runtime серверийн хаяг тохируулагдаагүй байна." },
      { status: 500, headers },
    )
  }

  const session = await input.session()
  const account = currentAuthAccount(session)
  if (!account && session.suspended) {
    return Response.json(
      { error: "account_suspended", message: "Таны MongolGPT бүртгэлийг түр түдгэлзүүлсэн байна." },
      { status: 423, headers },
    )
  }
  if (!account) {
    return Response.json(
      { error: "unauthorized", message: "MongolGPT бүртгэлээр нэвтэрнэ үү." },
      { status: 401, headers },
    )
  }

  const now = input.now?.() ?? Math.floor(Date.now() / 1000)
  const token = await issueRuntimeCapability({
    accountID: account.id,
    authVersion: account.authVersion ?? 0,
    audience: runtimeAudience,
    secret: input.secret,
    ttlSeconds: TTL_SECONDS,
    now,
  })
  return Response.json(
    { token, expiresAt: (now + TTL_SECONDS) * 1000, account: { id: account.id, email: account.email } },
    { headers },
  )
}

function corsHeaders(appOrigin: string, includeOrigin: boolean) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    Vary: "Origin",
  })
  if (includeOrigin) {
    headers.set("Access-Control-Allow-Origin", appOrigin)
    headers.set("Access-Control-Allow-Credentials", "true")
  }
  return headers
}

function requestOrigin(request: Request, appOrigin: string | undefined) {
  const origin = request.headers.get("Origin")
  return appOrigin && origin === appOrigin ? appOrigin : undefined
}

function invalidOriginResponse() {
  return Response.json(
    { error: "invalid_origin", message: "Энэ хүсэлтийн гарал зөвшөөрөгдөөгүй байна." },
    { status: 403, headers: { "Cache-Control": "no-store", Vary: "Origin" } },
  )
}
