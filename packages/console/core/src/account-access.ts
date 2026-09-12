import { and, Database, eq, exists, inArray, isNull, notExists, sql } from "./drizzle"
import type { SQL } from "./drizzle"
import { AccountTable } from "./schema/account.sql"
import { AuthTable } from "./schema/auth.sql"
import { PlatformAdminRoles, PlatformAdminTable } from "./schema/admin.sql"
import { KeyTable } from "./schema/key.sql"
import { UserTable } from "./schema/user.sql"
import { AccountAccessPolicy } from "./account-access-policy"
import { hasPlatformAdminPermission } from "./platform-admin"
import { paymentBatchGuard } from "./payment-ledger"
import type { PaymentBatchDatabase, PaymentBatchQuery } from "./payment-ledger"

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

  export interface TransitionResult {
    accountID: string
    before: Status
    after: Status
    authVersion: number
    revokedApiKeys: number
    changed: boolean
  }

  export interface TransitionOptions {
    actor: { email: string; subject: string }
    batch?: typeof Database.batch
    effect?: (
      db: PaymentBatchDatabase,
      result: Omit<TransitionResult, "revokedApiKeys"> & { revokedApiKeys: SQL<number> },
    ) => readonly PaymentBatchQuery[]
  }

  export async function transition(input: unknown, options: TransitionOptions): Promise<TransitionResult> {
    const value = Transition.parse(input)
    const batch = options.batch ?? Database.batch
    const actor = and(
      eq(PlatformAdminTable.id, value.adminID),
      eq(PlatformAdminTable.email, options.actor.email),
      eq(PlatformAdminTable.access_subject, options.actor.subject),
      eq(PlatformAdminTable.status, "active"),
      inArray(
        PlatformAdminTable.role,
        PlatformAdminRoles.filter((role) => hasPlatformAdminPermission(role, "users.suspend")),
      ),
      isNull(PlatformAdminTable.timeDeleted),
    )
    const self = and(
      eq(AuthTable.accountID, value.accountID),
      eq(AuthTable.provider, "email"),
      sql`lower(trim(${AuthTable.subject})) = ${options.actor.email}`,
      isNull(AuthTable.timeDeleted),
    )
    const snapshot = await batch((db) => [
      db
        .select()
        .from(AccountTable)
        .where(and(eq(AccountTable.id, value.accountID), isNull(AccountTable.timeDeleted)))
        .limit(1),
      db.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable).where(actor).limit(1),
      db.select({ id: AuthTable.id }).from(AuthTable).where(self).limit(1),
    ])
    if (!snapshot[1][0]) throw new TransitionError("forbidden")
    const current = snapshot[0][0]
    if (!current) throw new TransitionError("not_found")
    if (value.status === "suspended" && snapshot[2][0]) throw new TransitionError("self_suspend")
    const changed = current.status !== value.status
    const authVersion = current.auth_version + (changed && value.status === "suspended" ? 1 : 0)
    if (!Number.isSafeInteger(authVersion) || authVersion < 0) throw new TransitionError("conflict")
    const now = new Date(Math.max(Date.now(), current.timeUpdated.getTime() + 1))
    const transition = {
      accountID: current.id,
      before: current.status,
      after: value.status,
      authVersion,
      changed,
    }
    const sameAccount = and(
      eq(AccountTable.id, current.id),
      eq(AccountTable.status, current.status),
      eq(AccountTable.auth_version, current.auth_version),
      eq(AccountTable.timeUpdated, current.timeUpdated),
      isNull(AccountTable.timeDeleted),
    )
    const result = await batch((db) => {
      // Match the full membership key, including removed memberships, without trusting a stale user-ID list.
      const ownedKeys = and(
        isNull(KeyTable.timeDeleted),
        exists(
          db
            .select({ id: UserTable.id })
            .from(UserTable)
            .where(
              and(
                eq(UserTable.id, KeyTable.userID),
                eq(UserTable.workspaceID, KeyTable.workspaceID),
                eq(UserTable.accountID, value.accountID),
              ),
            ),
        ),
      )
      return [
        paymentBatchGuard(
          db,
          and(
            exists(db.select({ id: AccountTable.id }).from(AccountTable).where(sameAccount)),
            exists(db.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable).where(actor)),
            value.status === "suspended"
              ? notExists(db.select({ id: AuthTable.id }).from(AuthTable).where(self))
              : sql`1 = 1`,
          ),
        ),
        db
          .update(AccountTable)
          .set({
            timeUpdated: now,
            ...(changed
              ? value.status === "suspended"
                ? {
                    status: value.status,
                    auth_version: authVersion,
                    suspension_reason: value.reason,
                    suspended_by: value.adminID,
                    time_suspended: now,
                  }
                : {
                    status: value.status,
                    suspension_reason: null,
                    suspended_by: null,
                    time_suspended: null,
                  }
              : {}),
          })
          .where(sameAccount),
        paymentBatchGuard(db, sql`changes() = 1`),
        db
          .update(KeyTable)
          .set({ timeDeleted: now, timeUpdated: now })
          .where(and(ownedKeys, sql`${value.status === "suspended" ? 1 : 0} = 1`))
          .returning({ id: KeyTable.id }),
        paymentBatchGuard(
          db,
          and(
            exists(
              db
                .select({ id: AccountTable.id })
                .from(AccountTable)
                .where(
                  and(
                    eq(AccountTable.id, current.id),
                    eq(AccountTable.status, value.status),
                    eq(AccountTable.auth_version, authVersion),
                    eq(AccountTable.timeUpdated, now),
                    isNull(AccountTable.timeDeleted),
                  ),
                ),
            ),
            value.status === "suspended"
              ? notExists(db.select({ id: KeyTable.id }).from(KeyTable).where(ownedKeys))
              : sql`1 = 1`,
          ),
        ),
        // SELECT guards do not reset SQLite changes(); the audit records the actual key-update count.
        ...(options.effect?.(db, { ...transition, revokedApiKeys: sql<number>`changes()` }) ?? []),
      ]
    })
    return { ...transition, revokedApiKeys: result[3].length }
  }

  export class TransitionError extends Error {
    constructor(readonly code: "not_found" | "conflict" | "forbidden" | "self_suspend") {
      super(code)
      this.name = "AccountAccessTransitionError"
    }
  }
}
