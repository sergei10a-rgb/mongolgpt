import type { APIEvent } from "@solidjs/start/server"
import { ZenData } from "@mongolgpt/console-core/model.js"
import { and, Database, eq, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import { KeyTable } from "@mongolgpt/console-core/schema/key.sql.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import { ModelTable } from "@mongolgpt/console-core/schema/model.sql.js"
import { buildOptionsResponse, buildModelsResponse } from "~/routes/zen/util/modelsHandler"
import { verifyCliToken } from "~/lib/cli-auth"

export async function OPTIONS(_input: APIEvent) {
  return buildOptionsResponse()
}

export async function GET(input: APIEvent) {
  const authorization = input.request.headers.get("authorization")
  const workspaceID = authorization ? await authenticatedWorkspace(input.request, authorization) : undefined
  if (authorization && !workspaceID) return unauthorized()
  const disabledModels = workspaceID
    ? await Database.use((tx) =>
        tx
          .select({ model: ModelTable.model })
          .from(ModelTable)
          .where(and(eq(ModelTable.workspaceID, workspaceID), isNull(ModelTable.timeDeleted)))
          .then((rows) => rows.map((row) => row.model)),
      )
    : []

  const models = Object.keys(ZenData.list("full").models)
    .filter((id) => !id.endsWith(":global"))
    .filter((id) => !disabledModels.includes(id))

  return buildModelsResponse(models)
}

async function authenticatedWorkspace(request: Request, authorization: string): Promise<string | undefined> {
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return undefined

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

  const account = await verifyCliToken(token)
  const requested = request.headers.get("x-org-id")
  if (!account || !requested) return undefined
  return Database.use((tx) =>
    tx
      .select({ id: WorkspaceTable.id })
      .from(UserTable)
      .innerJoin(WorkspaceTable, and(eq(WorkspaceTable.id, UserTable.workspaceID), isNull(WorkspaceTable.timeDeleted)))
      .where(
        and(
          eq(UserTable.accountID, account.accountID),
          eq(UserTable.workspaceID, requested),
          isNull(UserTable.timeDeleted),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]?.id),
  )
}

function unauthorized() {
  return Response.json(
    {
      error: {
        type: "authentication_error",
        message: "MongolGPT нэвтрэх эрх буруу эсвэл хүчингүй болсон байна.",
      },
    },
    {
      status: 401,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    },
  )
}
