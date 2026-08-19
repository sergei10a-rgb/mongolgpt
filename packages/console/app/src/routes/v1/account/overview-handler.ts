import { AccountOverviewSchema } from "@mongolgpt/account-contract"
import {
  AccountOverviewNotFoundError,
  AccountOverviewSuspendedError,
  AccountOverviewWorkspaceAccessError,
} from "@mongolgpt/console-core/account-overview.js"
import { canonicalHttpsOrigin } from "../../auth/helpers"
import { z } from "zod"

const PREFLIGHT_MAX_AGE = "600"
const workspaceID = z.string().trim().min(5).max(30).regex(/^wrk_/)

export type AccountOverviewIdentity =
  | { status: "authenticated"; account: { id: string; email: string } }
  | { status: "unauthorized" }
  | { status: "suspended" }

export function accountOverviewPreflight(request: Request, appUrl: string | undefined) {
  const origin = allowedOrigin(request, appUrl)
  if (!origin) return invalidOrigin()
  const headers = responseHeaders(origin)
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS")
  headers.set("Access-Control-Allow-Headers", "Authorization, X-Org-ID")
  headers.set("Access-Control-Max-Age", PREFLIGHT_MAX_AGE)
  return new Response(null, { status: 204, headers })
}

export async function accountOverviewRequest(
  request: Request,
  input: {
    appUrl: string | undefined
    authenticate: (request: Request) => Promise<AccountOverviewIdentity>
    load: (input: { accountID: string; email: string; currentWorkspaceID?: string }) => Promise<unknown>
  },
) {
  const requestOrigin = request.headers.get("Origin")
  const origin = requestOrigin ? allowedOrigin(request, input.appUrl) : undefined
  if (requestOrigin && !origin) return invalidOrigin()
  const headers = responseHeaders(origin)
  const identity = await input.authenticate(request)
  if (identity.status === "unauthorized") {
    return Response.json(
      { error: "unauthorized", message: "MongolGPT бүртгэлээр нэвтэрнэ үү." },
      { status: 401, headers },
    )
  }
  if (identity.status === "suspended") {
    return Response.json(
      { error: "account_suspended", message: "Таны MongolGPT бүртгэлийг түр түдгэлзүүлсэн байна." },
      { status: 423, headers },
    )
  }

  const requestedWorkspaceID = request.headers.get("x-org-id")?.trim() || undefined
  const parsedWorkspaceID = workspaceID.optional().safeParse(requestedWorkspaceID)
  if (!parsedWorkspaceID.success) {
    return Response.json(
      { error: "invalid_request", message: "Account overview хүсэлтийн workspace буруу байна." },
      { status: 400, headers },
    )
  }

  try {
    const overview = await input.load({
      accountID: identity.account.id,
      email: identity.account.email,
      currentWorkspaceID: parsedWorkspaceID.data,
    })
    return Response.json(AccountOverviewSchema.parse(overview), { headers })
  } catch (error) {
    if (error instanceof AccountOverviewSuspendedError) {
      return Response.json(
        { error: "account_suspended", message: "Таны MongolGPT бүртгэлийг түр түдгэлзүүлсэн байна." },
        { status: 423, headers },
      )
    }
    if (error instanceof AccountOverviewNotFoundError || error instanceof AccountOverviewWorkspaceAccessError) {
      return Response.json(
        { error: "forbidden", message: "Энэ аккаунтын мэдээлэлд хандах эрхгүй байна." },
        { status: 403, headers },
      )
    }
    throw error
  }
}

function allowedOrigin(request: Request, appUrl: string | undefined) {
  const appOrigin = canonicalHttpsOrigin(appUrl)
  return appOrigin && request.headers.get("Origin") === appOrigin ? appOrigin : undefined
}

function responseHeaders(origin?: string) {
  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" })
  if (!origin) return headers
  headers.set("Access-Control-Allow-Origin", origin)
  headers.set("Access-Control-Allow-Credentials", "true")
  return headers
}

function invalidOrigin() {
  return Response.json(
    { error: "invalid_origin", message: "Энэ хүсэлтийн гарал зөвшөөрөгдөөгүй байна." },
    { status: 403, headers: responseHeaders() },
  )
}
