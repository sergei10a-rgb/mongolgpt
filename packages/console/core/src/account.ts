import { z } from "zod"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { fn } from "./util/fn"
import { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { AccountTable } from "./schema/account.sql"
import { AuthTable } from "./schema/auth.sql"
import { UserTable } from "./schema/user.sql"
import { KeyTable } from "./schema/key.sql"
import { CouponTable } from "./schema/billing.sql"

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
    return Database.transaction(async (tx) => {
      const account = await tx
        .select({ id: AccountTable.id })
        .from(AuthTable)
        .innerJoin(AccountTable, eq(AccountTable.id, AuthTable.accountID))
        .where(and(eq(AuthTable.provider, "email"), eq(AuthTable.subject, email), isNull(AccountTable.timeDeleted)))
        .then((rows) => rows[0])
      if (!account) throw new Error("Account not found")

      return removeByID(tx, { accountID: account.id, now: new Date() })
    })
  })

  export async function removeByID(
    tx: Database.TxOrDb,
    input: {
      accountID: string
      now: Date
    },
  ) {
    const account = await tx
      .select({ id: AccountTable.id, timeDeleted: AccountTable.timeDeleted })
      .from(AccountTable)
      .where(eq(AccountTable.id, input.accountID))
      .limit(1)
      .then((rows) => rows[0])
    if (!account || account.timeDeleted) {
      return {
        accountID: input.accountID,
        changed: false,
        revokedApiKeys: 0,
        anonymizedUsers: 0,
      }
    }

    const emails = await tx
      .select({ email: AuthTable.subject })
      .from(AuthTable)
      .where(and(eq(AuthTable.accountID, account.id), eq(AuthTable.provider, "email")))
    const users = await tx
      .select({ id: UserTable.id })
      .from(UserTable)
      .where(and(eq(UserTable.accountID, account.id), isNull(UserTable.timeDeleted)))
    const userIDs = users.map((user) => user.id)
    const revokedApiKeys =
      userIDs.length === 0
        ? []
        : await tx
            .update(KeyTable)
            .set({
              name: "",
              key: sql`'revoked:' || ${KeyTable.id}`,
              timeUsed: null,
              timeDeleted: input.now,
              timeUpdated: input.now,
            })
            .where(and(inArray(KeyTable.userID, userIDs), isNull(KeyTable.timeDeleted)))
            .returning({ id: KeyTable.id })
    const anonymizedUsers = await tx
      .update(UserTable)
      .set({
        accountID: null,
        email: null,
        name: "",
        timeDeleted: input.now,
        timeUpdated: input.now,
      })
      .where(and(eq(UserTable.accountID, account.id), isNull(UserTable.timeDeleted)))
      .returning({ id: UserTable.id })
    if (emails.length > 0) {
      await tx.delete(CouponTable).where(
        inArray(
          CouponTable.email,
          emails.map((row) => row.email),
        ),
      )
    }
    await tx.delete(AuthTable).where(eq(AuthTable.accountID, account.id))
    const deleted = await tx
      .update(AccountTable)
      .set({
        auth_version: sql`${AccountTable.auth_version} + 1`,
        timeDeleted: input.now,
        timeUpdated: input.now,
      })
      .where(and(eq(AccountTable.id, account.id), isNull(AccountTable.timeDeleted)))
      .returning({ id: AccountTable.id })
      .then((rows) => rows[0])

    return {
      accountID: account.id,
      changed: Boolean(deleted),
      revokedApiKeys: revokedApiKeys.length,
      anonymizedUsers: anonymizedUsers.length,
    }
  }

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
