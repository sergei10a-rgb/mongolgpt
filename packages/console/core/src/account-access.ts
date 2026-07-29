import { and, Database, eq, inArray, isNull } from "./drizzle"
import { AccountTable } from "./schema/account.sql"
import { KeyTable } from "./schema/key.sql"
import { UserTable } from "./schema/user.sql"
import { AccountAccessPolicy } from "./account-access-policy"

export namespace AccountAccess {
  export const Reason = AccountAccessPolicy.Reason
  export const Transition = AccountAccessPolicy.Transition
  export type Status = AccountAccessPolicy.Status
  export type Transition = AccountAccessPolicy.Transition
  export type Record = AccountAccessPolicy.Record
  export type Decision = AccountAccessPolicy.Decision
  export const evaluate = AccountAccessPolicy.evaluate

  export async function verify(input: { accountID: string; authVersion?: number }) {
    return Database.use(async (tx) => {
      const record = await tx
        .select({
          id: AccountTable.id,
          status: AccountTable.status,
          auth_version: AccountTable.auth_version,
          timeDeleted: AccountTable.timeDeleted,
        })
        .from(AccountTable)
        .where(eq(AccountTable.id, input.accountID))
        .limit(1)
        .then((rows) => rows[0])
      return evaluate(record, input.authVersion)
    })
  }

  export async function transition(tx: Database.TxOrDb, input: unknown) {
    const value = Transition.parse(input)
    const current = await tx
      .select({
        id: AccountTable.id,
        status: AccountTable.status,
        auth_version: AccountTable.auth_version,
      })
      .from(AccountTable)
      .where(and(eq(AccountTable.id, value.accountID), isNull(AccountTable.timeDeleted)))
      .limit(1)
      .then((rows) => rows[0])

    if (!current) throw new TransitionError("not_found")
    if (current.status === value.status) {
      const revokedApiKeys =
        value.status === "suspended" ? await revokeAccountApiKeys(tx, value.accountID, new Date()) : 0
      return {
        accountID: current.id,
        before: current.status,
        after: current.status,
        authVersion: current.auth_version,
        revokedApiKeys,
        changed: false,
      }
    }

    const now = new Date()
    const update =
      value.status === "suspended"
        ? {
            status: value.status,
            auth_version: current.auth_version + 1,
            suspension_reason: value.reason,
            suspended_by: value.adminID,
            time_suspended: now,
            timeUpdated: now,
          }
        : {
            status: value.status,
            suspension_reason: null,
            suspended_by: null,
            time_suspended: null,
            timeUpdated: now,
          }
    const changed = await tx
      .update(AccountTable)
      .set(update)
      .where(
        and(
          eq(AccountTable.id, value.accountID),
          eq(AccountTable.status, current.status),
          eq(AccountTable.auth_version, current.auth_version),
          isNull(AccountTable.timeDeleted),
        ),
      )
      .returning({
        id: AccountTable.id,
        status: AccountTable.status,
        auth_version: AccountTable.auth_version,
      })
      .then((rows) => rows[0])

    if (!changed) throw new TransitionError("conflict")
    const revokedApiKeys = changed.status === "suspended" ? await revokeAccountApiKeys(tx, changed.id, now) : 0
    return {
      accountID: changed.id,
      before: current.status,
      after: changed.status,
      authVersion: changed.auth_version,
      revokedApiKeys,
      changed: true,
    }
  }

  async function revokeAccountApiKeys(tx: Database.TxOrDb, accountID: string, now: Date) {
    const users = await tx
      .select({ id: UserTable.id })
      .from(UserTable)
      .where(and(eq(UserTable.accountID, accountID), isNull(UserTable.timeDeleted)))
    if (users.length === 0) return 0

    const revoked = await tx
      .update(KeyTable)
      .set({
        timeDeleted: now,
        timeUpdated: now,
      })
      .where(
        and(
          inArray(
            KeyTable.userID,
            users.map((user) => user.id),
          ),
          isNull(KeyTable.timeDeleted),
        ),
      )
      .returning({ id: KeyTable.id })
    return revoked.length
  }

  export class TransitionError extends Error {
    constructor(readonly code: "not_found" | "conflict") {
      super(code)
      this.name = "AccountAccessTransitionError"
    }
  }
}
