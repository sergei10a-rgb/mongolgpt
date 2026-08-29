import { z } from "zod"
import { fn } from "./util/fn"
import { Actor } from "./actor"
import { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { UserTable } from "./schema/user.sql"
import { BillingTable } from "./schema/billing.sql"
import { WorkspaceTable } from "./schema/workspace.sql"
import { AccountTable } from "./schema/account.sql"
import { KeyTable } from "./schema/key.sql"
import { Key } from "./key"
import { eq, sql } from "drizzle-orm"

export namespace Workspace {
  export async function createForAccount(
    input: { accountID: string; name: string },
    batch: typeof Database.batch = Database.batch,
  ) {
    const workspaceID = Identifier.create("workspace")
    const userID = Identifier.create("user")
    const key = Key.record({ workspaceID, userID, name: "Default API Key" })
    // A missing or deleted account produces a NULL id and makes D1 roll the whole batch back.
    await batch(
      (db) =>
        [
          db.insert(WorkspaceTable).values({
            id: sql<string>`case when exists (
            select 1 from ${AccountTable}
            where ${AccountTable.id} = ${input.accountID}
              and ${AccountTable.timeDeleted} is null
          ) then ${workspaceID} else null end`,
            name: input.name,
          }),
          db.insert(UserTable).values({
            workspaceID,
            id: userID,
            accountID: input.accountID,
            name: "",
            role: "admin",
          }),
          db.insert(BillingTable).values({
            workspaceID,
            id: Identifier.create("billing"),
            balance: 0,
          }),
          db.insert(KeyTable).values(key),
        ] as const,
    )
    return workspaceID
  }

  export const create = fn(
    z.object({
      name: z.string().min(1),
    }),
    async ({ name }) => {
      const account = Actor.assert("account")
      return createForAccount({ accountID: account.properties.accountID, name })
    },
  )

  export const update = fn(
    z.object({
      name: z.string().min(1).max(255),
    }),
    async ({ name }) => {
      Actor.assertAdmin()
      const workspaceID = Actor.workspace()
      return await Database.use((tx) =>
        tx
          .update(WorkspaceTable)
          .set({
            name,
          })
          .where(eq(WorkspaceTable.id, workspaceID)),
      )
    },
  )

  export const remove = fn(z.void(), async () => {
    await Database.use((tx) =>
      tx.update(WorkspaceTable).set({ timeDeleted: new Date() }).where(eq(WorkspaceTable.id, Actor.workspace())),
    )
  })
}
