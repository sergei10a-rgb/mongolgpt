import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { verifyCliAccount } from "~/lib/cli-auth"
import { createAccountConfig, selectAccountWorkspace } from "./account-config"

export async function GET(event: APIEvent) {
  const result = await verifyCliAccount(event.request)
  if ("response" in result) return result.response

  const orgID = event.request.headers.get("x-org-id")
  const users = await Database.use((tx) =>
    tx
      .select({ workspaceID: UserTable.workspaceID })
      .from(UserTable)
      .where(
        and(
          eq(UserTable.accountID, result.account.accountID),
          orgID ? eq(UserTable.workspaceID, orgID) : undefined,
          isNull(UserTable.timeDeleted),
        ),
      )
      .orderBy(UserTable.workspaceID)
      .limit(orgID ? 1 : 2),
  )
  const workspace = selectAccountWorkspace(users, Boolean(orgID))
  if (workspace.status === "forbidden")
    return Response.json(
      { error: "forbidden", message: "Энэ аккаунтад ашиглах боломжтой байгууллага олдсонгүй" },
      { status: 403 },
    )
  if (workspace.status === "organization-required")
    return Response.json(
      {
        error: "organization_required",
        message: "Энэ аккаунтад олон байгууллага байна. Ашиглах байгууллагаа сонгоно уу.",
      },
      { status: 409 },
    )

  return Response.json({
    config: createAccountConfig({ origin: new URL(event.request.url).origin, workspaceID: workspace.workspaceID }),
  })
}
