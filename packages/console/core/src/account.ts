import { z } from "zod"
import { and, eq, isNull } from "drizzle-orm"
import { fn } from "./util/fn"
import { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { AccountTable } from "./schema/account.sql"
import { AuthTable } from "./schema/auth.sql"

export namespace Account {
  export const create = fn(
    z.object({
      id: z.string().optional(),
    }),
    async (input) =>
      Database.use(async (tx) => {
        const id = input.id ?? Identifier.create("account")
        await tx.insert(AccountTable).values({
          id,
        })
        return id
      }),
  )

  export const remove = fn(z.email(), async (email) => {
    const { requestAccountDeletion, AccountDeletionError } = await import("./account-deletion")
    const account = await Database.use((tx) =>
      tx
        .select({ id: AccountTable.id })
        .from(AuthTable)
        .innerJoin(AccountTable, eq(AccountTable.id, AuthTable.accountID))
        .where(and(eq(AuthTable.provider, "email"), eq(AuthTable.subject, email), isNull(AccountTable.timeDeleted)))
        .limit(1)
        .then((rows) => rows[0]),
    )
    if (!account) throw new AccountDeletionError("not_found")
    return requestAccountDeletion({ accountID: account.id })
  })

  export const fromID = fn(z.string(), async (id) =>
    Database.use((tx) =>
      tx
        .select()
        .from(AccountTable)
        .where(eq(AccountTable.id, id))
        .then((rows) => rows[0]),
    ),
  )
}
