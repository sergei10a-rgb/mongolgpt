import { accountRuntimeToken } from "../../lib/runtime-token"
import {
  hostedPreviewConfig,
  hostedPreviewRuntimeAudience,
  type HostedPreviewConfigInput,
} from "../../lib/hosted-preview"
import { canonicalHttpsOrigin, currentAuthAccount } from "./helpers"

const PREFLIGHT_MAX_AGE = "600"

export function runtimeTokenPreflight(
  request: Request,
  appUrl: string | undefined,
  preview?: HostedPreviewConfigInput,
) {
  const appOrigin = canonicalHttpsOrigin(appUrl)
  const origin = requestOrigin(request, appOrigin, preview)
  if (!origin) return invalidOriginResponse()

  const headers = corsHeaders(origin, true)
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS")
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Org-ID")
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
    workspaces: (accountID: string) => Promise<readonly { id: string; name: string }[]>
    preview?: HostedPreviewConfigInput
    now?: () => number
  },
) {
  const appOrigin = canonicalHttpsOrigin(input.appUrl)
  const origin = requestOrigin(request, appOrigin, input.preview)
  if (!origin) return invalidOriginResponse()

  const headers = corsHeaders(origin, true)
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

  const runtimeAudience = runtimeTokenAudience(request, account, input)
  if (runtimeAudience.status === "forbidden") {
    return Response.json(
      { error: "preview_forbidden", message: "Preview runtime token энэ бүртгэлд зөвшөөрөгдөөгүй байна." },
      { status: 403, headers },
    )
  }
  if (runtimeAudience.status === "not_configured") {
    return Response.json(
      { error: "runtime_not_configured", message: "MongolGPT runtime серверийн хаяг тохируулагдаагүй байна." },
      { status: 500, headers },
    )
  }

  return accountRuntimeToken(
    request,
    {
      account,
      audience: runtimeAudience.audience,
      secret: input.secret,
      workspaces: input.workspaces,
      now: input.now,
    },
    headers,
  )
}

function runtimeTokenAudience(
  request: Request,
  account: { email: string },
  input: { runtimeUrl: string | undefined; preview?: HostedPreviewConfigInput },
): { status: "allowed"; audience: string } | { status: "forbidden" } | { status: "not_configured" } {
  const preview = input.preview
    ? hostedPreviewRuntimeAudience({
        ...input.preview,
        requestOrigin: request.headers.get("Origin"),
        accountEmail: account.email,
      })
    : { matched: false as const }
  if (preview.matched && preview.status === "allowed") return { status: "allowed", audience: preview.audience }
  if (preview.matched) return { status: "forbidden" }
  const audience = canonicalHttpsOrigin(input.runtimeUrl)
  return audience ? { status: "allowed", audience } : { status: "not_configured" }
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

function requestOrigin(request: Request, appOrigin: string | undefined, preview?: HostedPreviewConfigInput) {
  const origin = request.headers.get("Origin")
  if (appOrigin && origin === appOrigin) return appOrigin
  const configured = preview && hostedPreviewConfig(preview)
  if (configured && origin === configured.origin && new URL(request.url).origin === preview?.hostedConsoleUrl)
    return origin
  return undefined
}

function invalidOriginResponse() {
  return Response.json(
    { error: "invalid_origin", message: "Энэ хүсэлтийн гарал зөвшөөрөгдөөгүй байна." },
    { status: 403, headers: { "Cache-Control": "no-store", Vary: "Origin" } },
  )
}
