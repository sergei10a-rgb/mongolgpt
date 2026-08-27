import { issueRuntimeCapability } from "@mongolgpt/runtime-auth"
import {
  AccountOverviewNotFoundError,
  AccountOverviewSuspendedError,
} from "@mongolgpt/console-core/account-overview.js"
import { canonicalHttpsOrigin, currentAuthAccount } from "./helpers"

const TTL_SECONDS = 90
const PREFLIGHT_MAX_AGE = "600"

export function runtimeTokenPreflight(request: Request, appUrl: string | undefined) {
  const appOrigin = canonicalHttpsOrigin(appUrl)
  const origin = requestOrigin(request, appOrigin)
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

  const requestedWorkspaceID = request.headers.get("x-org-id")?.trim() || undefined
  if (requestedWorkspaceID && !validWorkspaceID(requestedWorkspaceID)) {
    return Response.json(
      { error: "invalid_request", message: "Ажлын талбарын сонголт буруу байна." },
      { status: 400, headers },
    )
  }

  let workspaces: readonly { id: string; name: string }[]
  try {
    workspaces = normalizeWorkspaces(await input.workspaces(account.id))
  } catch (error) {
    if (error instanceof AccountOverviewSuspendedError) {
      return Response.json(
        { error: "account_suspended", message: "Таны MongolGPT бүртгэлийг түр түдгэлзүүлсэн байна." },
        { status: 423, headers },
      )
    }
    if (error instanceof AccountOverviewNotFoundError) {
      return Response.json(
        { error: "unauthorized", message: "MongolGPT бүртгэлээр дахин нэвтэрнэ үү." },
        { status: 401, headers },
      )
    }
    throw error
  }

  const workspace = requestedWorkspaceID
    ? workspaces.find((item) => item.id === requestedWorkspaceID)
    : workspaces.length === 1
      ? workspaces[0]
      : undefined
  if (!workspace) {
    const forbidden = requestedWorkspaceID !== undefined || workspaces.length === 0
    return Response.json(
      {
        error: forbidden ? "workspace_forbidden" : "workspace_required",
        message: forbidden ? "Энэ ажлын талбарт хандах эрхгүй байна." : "Ашиглах ажлын талбараа сонгоно уу.",
        account: { id: account.id, email: account.email },
        workspaces,
      },
      { status: forbidden ? 403 : 409, headers },
    )
  }

  const now = input.now?.() ?? Math.floor(Date.now() / 1000)
  const token = await issueRuntimeCapability({
    accountID: account.id,
    workspaceID: workspace.id,
    authVersion: account.authVersion ?? 0,
    audience: runtimeAudience,
    secret: input.secret,
    ttlSeconds: TTL_SECONDS,
    now,
  })
  return Response.json(
    {
      token,
      expiresAt: (now + TTL_SECONDS) * 1000,
      account: { id: account.id, email: account.email },
      workspace,
    },
    { headers },
  )
}

function validWorkspaceID(value: string) {
  return value.startsWith("wrk_") && value.length >= 5 && value.length <= 30
}

function normalizeWorkspaces(input: readonly { id: string; name: string }[]) {
  if (!Array.isArray(input)) throw new TypeError("Ажлын талбарын жагсаалт буруу байна")
  const seen = new Set<string>()
  return input.map((workspace) => {
    if (
      !workspace ||
      !validWorkspaceID(workspace.id) ||
      typeof workspace.name !== "string" ||
      workspace.name.length === 0 ||
      workspace.name.length > 255 ||
      workspace.name.trim() !== workspace.name ||
      seen.has(workspace.id)
    ) {
      throw new TypeError("Ажлын талбарын жагсаалт буруу байна")
    }
    seen.add(workspace.id)
    return { id: workspace.id, name: workspace.name }
  })
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
