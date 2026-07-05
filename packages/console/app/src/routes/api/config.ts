import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { verifyCliAccount } from "~/lib/cli-auth"

export async function GET(event: APIEvent) {
  const result = await verifyCliAccount(event.request)
  if ("response" in result) return result.response

  const orgID = event.request.headers.get("x-org-id")
  if (orgID) {
    const user = await Database.use((tx) =>
      tx
        .select({ id: UserTable.id })
        .from(UserTable)
        .where(
          and(
            eq(UserTable.workspaceID, orgID),
            eq(UserTable.accountID, result.account.accountID),
            isNull(UserTable.timeDeleted),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]),
    )
    if (!user)
      return Response.json(
        { error: "forbidden", message: "Энэ account тухайн байгууллагад хандах эрхгүй байна" },
        { status: 403 },
      )
  }

  return Response.json({ config: {} })
}
