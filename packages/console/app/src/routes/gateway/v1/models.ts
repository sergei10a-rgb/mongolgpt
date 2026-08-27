import type { APIEvent } from "@solidjs/start/server"
import { GatewayCatalog } from "@mongolgpt/console-core/model.js"
import { and, Database, eq, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import { KeyTable } from "@mongolgpt/console-core/schema/key.sql.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import { ModelTable } from "@mongolgpt/console-core/schema/model.sql.js"
import { buildAuthenticatedModelsResponse, buildOptionsResponse } from "~/routes/gateway/util/modelsHandler"
import { resolveGatewayWorkspace, verifyGatewayAccount } from "~/lib/cli-auth"

export async function OPTIONS(_input: APIEvent) {
  return buildOptionsResponse()
}

export async function GET(input: APIEvent) {
  return buildAuthenticatedModelsResponse(input.request, {
    authenticate: authenticatedWorkspace,
    disabled: (workspaceID) =>
      Database.use((tx) =>
        tx
          .select({ model: ModelTable.model })
          .from(ModelTable)
          .where(and(eq(ModelTable.workspaceID, workspaceID), isNull(ModelTable.timeDeleted)))
          .then((rows) => rows.map((row) => row.model)),
      ),
    models: () => Object.keys(GatewayCatalog.list("full").models),
  })
}

async function authenticatedWorkspace(request: Request, token: string): Promise<string | undefined> {
  const workspaceID = await Database.use((tx) =>
    tx
      .select({ id: KeyTable.workspaceID })
      .from(KeyTable)
      .innerJoin(UserTable, and(eq(UserTable.id, KeyTable.userID), eq(UserTable.workspaceID, KeyTable.workspaceID)))
      .innerJoin(
        AccountTable,
        and(
          eq(AccountTable.id, UserTable.accountID),
          eq(AccountTable.status, "active"),
          isNull(AccountTable.timeDeleted),
        ),
      )
      .innerJoin(WorkspaceTable, and(eq(WorkspaceTable.id, KeyTable.workspaceID), isNull(WorkspaceTable.timeDeleted)))
      .where(and(eq(KeyTable.key, token), isNull(KeyTable.timeDeleted), isNull(UserTable.timeDeleted)))
      .limit(1)
      .then((rows) => rows[0]?.id),
  )
  if (workspaceID) return workspaceID

  const account = await verifyGatewayAccount(request, token)
  if (!account) return undefined
  const workspace = await resolveGatewayWorkspace(account, request.headers.get("x-org-id"))
  return "workspaceID" in workspace ? workspace.workspaceID : undefined
}
