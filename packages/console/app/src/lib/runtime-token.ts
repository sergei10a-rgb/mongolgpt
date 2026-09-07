import { issueRuntimeCapability } from "@mongolgpt/runtime-auth"
import {
  AccountOverviewNotFoundError,
  AccountOverviewSuspendedError,
} from "@mongolgpt/console-core/account-overview.js"

export async function accountRuntimeToken(
  request: Request,
  input: {
    account: { id: string; email: string; authVersion?: number }
    audience: string
    secret: string
    workspaces: (accountID: string) => Promise<readonly { id: string; name: string }[]>
    now?: () => number
  },
  headers: Headers,
) {
  const account = input.account
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
    audience: input.audience,
    secret: input.secret,
    ttlSeconds: 90,
    now,
  })
  return Response.json(
    {
      token,
      expiresAt: (now + 90) * 1000,
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
