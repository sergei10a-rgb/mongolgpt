import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import { verifyCliAccount } from "~/lib/cli-auth"

export async function GET(event: APIEvent) {
  const result = await verifyCliAccount(event.request)
  if ("response" in result) return result.response

  const orgs = await Database.use((tx) =>
    tx
      .select({
        id: WorkspaceTable.id,
        name: WorkspaceTable.name,
      })
      .from(UserTable)
      .innerJoin(WorkspaceTable, eq(UserTable.workspaceID, WorkspaceTable.id))
      .where(
        and(
          eq(UserTable.accountID, result.account.accountID),
          isNull(UserTable.timeDeleted),
          isNull(WorkspaceTable.timeDeleted),
        ),
      )
      .orderBy(WorkspaceTable.name),
  )

  return Response.json(orgs)
}
