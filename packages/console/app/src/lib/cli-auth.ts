import { createClient } from "@openauthjs/openauth/client"
import { createSubjects } from "@openauthjs/openauth/subject"
import { Resource } from "@mongolgpt/console-resource"
import { AccountAccess } from "@mongolgpt/console-core/account-access.js"
import { and, Database, eq, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import { verifyRuntimeCapability } from "@mongolgpt/runtime-auth"
import { z } from "zod"

const subjects = createSubjects({
  account: z.object({
    accountID: z.string(),
    email: z.string(),
    newAccount: z.boolean().optional(),
    authVersion: z.number().int().nonnegative().optional(),
  }),
  user: z.object({
    userID: z.string(),
    workspaceID: z.string(),
  }),
})

const authClient = createClient({
  clientID: "mongolgpt-cli",
  issuer: Resource.AUTH_API_URL.value,
  subjects,
})

export type CliAccount = {
  accountID: string
  email: string
  authVersion: number
}

export type GatewayAccount = Pick<CliAccount, "accountID" | "authVersion"> & {
  kind: "cli" | "runtime"
}

export async function verifyCliToken(token: string): Promise<CliAccount | undefined> {
  const verified = await authClient.verify(token).catch(() => undefined)
  if (!verified || "err" in verified || verified.subject.type !== "account") return undefined
  const authVersion = verified.subject.properties.authVersion ?? 0
  const access = await AccountAccess.verify({
    accountID: verified.subject.properties.accountID,
    authVersion,
  })
  if (!access.allowed) return undefined
  return {
    accountID: verified.subject.properties.accountID,
    email: verified.subject.properties.email,
    authVersion,
  }
}

export async function verifyGatewayAccount(request: Request, token?: string): Promise<GatewayAccount | undefined> {
  if (!token) return undefined
  const runtime = await verifyRuntimeAccount(request, token)
  if (runtime) return runtime

  const account = await verifyCliToken(token)
  return account ? { accountID: account.accountID, authVersion: account.authVersion, kind: "cli" } : undefined
}

async function verifyRuntimeAccount(request: Request, token: string): Promise<GatewayAccount | undefined> {
  try {
    const capability = await verifyRuntimeCapability({
      token,
      audience: new URL(request.url).origin,
      secret: Resource.MongolGPTRuntimeAuthSecret.value,
    })
    const access = await AccountAccess.verify({
      accountID: capability.sub,
      authVersion: capability.authVersion,
    })
    if (!access.allowed) return undefined
    return {
      accountID: capability.sub,
      authVersion: capability.authVersion,
      kind: "runtime",
    }
  } catch {
    return undefined
  }
}

export type GatewayWorkspaceResult =
  | { workspaceID: string }
  | { error: "workspace_required" | "workspace_ambiguous" | "workspace_forbidden" }

export function selectGatewayWorkspace(
  account: Pick<GatewayAccount, "kind">,
  workspaceIDs: readonly string[],
  requestedWorkspaceID: string | null,
): GatewayWorkspaceResult {
  if (requestedWorkspaceID) {
    return workspaceIDs.includes(requestedWorkspaceID)
      ? { workspaceID: requestedWorkspaceID }
      : { error: "workspace_forbidden" }
  }
  if (account.kind === "cli") return { error: "workspace_required" }
  if (workspaceIDs.length === 1) return { workspaceID: workspaceIDs[0] }
  return { error: workspaceIDs.length === 0 ? "workspace_forbidden" : "workspace_ambiguous" }
}

export async function resolveGatewayWorkspace(
  account: GatewayAccount,
  requestedWorkspaceID: string | null,
): Promise<GatewayWorkspaceResult> {
  const workspaces = await Database.use((tx) =>
    tx
      .select({ id: WorkspaceTable.id })
      .from(UserTable)
      .innerJoin(
        AccountTable,
        and(
          eq(AccountTable.id, UserTable.accountID),
          eq(AccountTable.status, "active"),
          isNull(AccountTable.timeDeleted),
        ),
      )
      .innerJoin(WorkspaceTable, and(eq(WorkspaceTable.id, UserTable.workspaceID), isNull(WorkspaceTable.timeDeleted)))
      .where(and(eq(UserTable.accountID, account.accountID), isNull(UserTable.timeDeleted)))
      .orderBy(WorkspaceTable.id),
  )

  return selectGatewayWorkspace(
    account,
    [...new Set(workspaces.map((workspace) => workspace.id))],
    requestedWorkspaceID,
  )
}

export async function verifyCliAccount(request: Request): Promise<{ account: CliAccount } | { response: Response }> {
  const header = request.headers.get("authorization")
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return { response: unauthorized("Нэвтрэх токен олдсонгүй") }

  const account = await verifyCliToken(token)
  if (!account) return { response: unauthorized("Аккаунтын токен буруу эсвэл хүчингүй болсон байна") }
  return { account }
}

function unauthorized(message: string) {
  return Response.json({ error: "unauthorized", message }, { status: 401 })
}
