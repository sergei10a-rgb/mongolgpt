import { and, eq, or, sql } from "drizzle-orm"
import { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { AccountTable } from "./schema/account.sql"
import { AuthTable } from "./schema/auth.sql"

type OAuthProvider = "github" | "google"

export type OAuthAccountProvisioningInput = {
  provider: OAuthProvider
  subject: string
  email: string
}

export type OAuthAccountProvisioningResult = {
  accountID: string
  newAccount: boolean
}

type OAuthAccountProvisioningDependencies = {
  use?: typeof Database.use
  batch?: typeof Database.batch
}

export class OAuthIdentityConflictError extends Error {
  constructor() {
    super("OAuth provider and email identities belong to different accounts")
  }
}

export async function provisionOAuthAccountIdentity(
  input: OAuthAccountProvisioningInput,
  dependencies: OAuthAccountProvisioningDependencies = {},
): Promise<OAuthAccountProvisioningResult> {
  const use = dependencies.use ?? Database.use
  const batch = dependencies.batch ?? Database.batch

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const matches = await use((db) =>
        db
          .select({
            provider: AuthTable.provider,
            accountID: AuthTable.accountID,
            timeDeleted: AuthTable.timeDeleted,
          })
          .from(AuthTable)
          .where(
            or(
              and(eq(AuthTable.provider, input.provider), eq(AuthTable.subject, input.subject)),
              and(eq(AuthTable.provider, "email"), eq(AuthTable.subject, input.email)),
            ),
          ),
      )
      const existingAccountID = resolveActiveAccountIdentity(matches, input.provider)
      const accountID = existingAccountID ?? Identifier.create("account")
      const newAccount = !existingAccountID
      const timeUpdated = new Date()

      await batch((db) => {
        const identities = [
          upsertOAuthIdentity(db, {
            accountID,
            provider: input.provider,
            subject: input.subject,
            timeUpdated,
          }),
          upsertOAuthIdentity(db, {
            accountID,
            provider: "email",
            subject: input.email,
            timeUpdated,
          }),
        ] as const
        if (!newAccount) return identities
        return [db.insert(AccountTable).values({ id: accountID }), ...identities] as const
      })

      return { accountID, newAccount }
    } catch (error) {
      if (isProvisioningRace(error)) continue
      throw error
    }
  }

  throw new Error("OAuth аккаунт үүсгэх үед давхцсан хүсэлт дууссангүй. Дахин оролдоно уу.")
}

function resolveActiveAccountIdentity(
  matches: Array<{
    provider: string
    accountID: string
    timeDeleted: unknown
  }>,
  provider: OAuthProvider,
) {
  const active = matches.filter((match) => match.timeDeleted === null)
  const providerAccountID = active.find((match) => match.provider === provider)?.accountID
  const emailAccountID = active.find((match) => match.provider === "email")?.accountID

  if (providerAccountID && emailAccountID && providerAccountID !== emailAccountID) {
    throw new OAuthIdentityConflictError()
  }

  return providerAccountID ?? emailAccountID
}

function upsertOAuthIdentity(
  db: Database.TxOrDb,
  input: {
    accountID: string
    provider: OAuthProvider | "email"
    subject: string
    timeUpdated: Date
  },
) {
  return db
    .insert(AuthTable)
    .values({
      id: Identifier.create("auth"),
      accountID: input.accountID,
      provider: input.provider,
      subject: input.subject,
      timeUpdated: input.timeUpdated,
    })
    .onConflictDoUpdate({
      target: [AuthTable.provider, AuthTable.subject],
      set: {
        // A conflicting active identity violates NOT NULL so D1 rolls the whole batch back.
        accountID: sql<string>`case
          when ${AuthTable.timeDeleted} is null
            and ${AuthTable.accountID} <> excluded.account_id
          then null
          else excluded.account_id
        end`,
        timeDeleted: null,
        timeUpdated: input.timeUpdated,
      },
    })
}

function isProvisioningRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (
    error.message.includes("UNIQUE constraint failed: auth.provider, auth.subject") ||
    error.message.includes("NOT NULL constraint failed: auth.account_id")
  ) {
    return true
  }
  return isProvisioningRace(error.cause)
}
