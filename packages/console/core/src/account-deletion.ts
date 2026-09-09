import { z } from "zod"
import { and, asc, eq, exists, inArray, isNotNull, isNull, lt, lte, ne, notExists, sql } from "./drizzle"
import { alias } from "drizzle-orm/sqlite-core"
import { Account } from "./account"
import { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { AccountTable } from "./schema/account.sql"
import { AccountDeletionTable } from "./schema/account-deletion.sql"
import { UserTable } from "./schema/user.sql"

export const ACCOUNT_DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1_000
export const ACCOUNT_DELETION_MAX_ATTEMPTS = 5
export const ACCOUNT_DELETION_RETRY_MS = 15 * 60 * 1_000
export const ACCOUNT_DELETION_OPERATIONAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

const AccountID = z.string().trim().min(1).max(255)
const Request = z.object({
  accountID: AccountID,
  graceMs: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60 * 60 * 1_000)
    .optional(),
})
const AccountInput = z.object({ accountID: AccountID })

type Use = <T>(callback: (db: Database.TxOrDb) => Promise<T>) => Promise<T>
type Transaction = <T>(callback: (db: Database.TxOrDb) => Promise<T>) => Promise<T>
type Remove = typeof Account.removeByID

export type AccountDeletionState = ReturnType<typeof state>

export class AccountDeletionError extends Error {
  constructor(readonly code: "not_found" | "too_late" | "workspace_admin_required") {
    super(code)
    this.name = "AccountDeletionError"
  }
}

export async function requestAccountDeletion(
  input: z.input<typeof Request>,
  dependencies: {
    now?: () => number
    batch?: typeof Database.batch
  } = {},
) {
  const value = Request.parse(input)
  const now = timestamp(dependencies.now?.() ?? Date.now())
  const eligibleAt = now + (value.graceMs ?? ACCOUNT_DELETION_GRACE_MS)
  const batch = dependencies.batch ?? Database.batch
  // D1 cannot hold an interactive transaction across awaits. Read policy, write,
  // and return the resulting state in one serialized batch instead.
  const [accounts, blocked, changed, current] = await batch((db) => {
    const account = and(eq(AccountTable.id, value.accountID), isNull(AccountTable.timeDeleted))
    const workspace = blockingWorkspace(db, value.accountID)
    return [
      db.select({ id: AccountTable.id }).from(AccountTable).where(account),
      workspace,
      db
        .insert(AccountDeletionTable)
        .select(
          db
            .select({
              id: sql<string>`${Identifier.create("accountDeletion")}`.as("id"),
              account_id: AccountTable.id,
              status: sql<"requested">`'requested'`.as("status"),
              attempts: sql<number>`0`.as("attempts"),
              last_error_code: sql<null>`null`.as("last_error_code"),
              time_eligible: sql<Date>`${eligibleAt}`.as("time_eligible"),
              time_started: sql<null>`null`.as("time_started"),
              time_completed: sql<null>`null`.as("time_completed"),
              time_cancelled: sql<null>`null`.as("time_cancelled"),
              timeCreated: sql<Date>`${now}`.as("time_created"),
              timeUpdated: sql<Date>`${now}`.as("time_updated"),
              timeDeleted: sql<null>`null`.as("time_deleted"),
            })
            .from(AccountTable)
            .where(and(account, notExists(workspace))),
        )
        .onConflictDoUpdate({
          target: AccountDeletionTable.account_id,
          set: {
            status: "requested",
            attempts: 0,
            last_error_code: null,
            time_eligible: new Date(eligibleAt),
            time_started: null,
            time_completed: null,
            time_cancelled: null,
            timeUpdated: new Date(now),
          },
          setWhere: and(
            inArray(AccountDeletionTable.status, ["failed", "cancelled"]),
            isNull(AccountDeletionTable.timeDeleted),
          ),
        })
        .returning(),
      findQuery(db, value.accountID),
    ] as const
  })
  if (!accounts[0]) throw new AccountDeletionError("not_found")
  if (blocked[0]) throw new AccountDeletionError("workspace_admin_required")
  const row = changed[0] ?? current[0]
  if (!row) throw new AccountDeletionError("not_found")
  return state(row, Boolean(changed[0]))
}

export async function cancelAccountDeletion(
  input: z.input<typeof AccountInput>,
  dependencies: {
    now?: () => number
    batch?: typeof Database.batch
  } = {},
) {
  const value = AccountInput.parse(input)
  const now = timestamp(dependencies.now?.() ?? Date.now())
  const batch = dependencies.batch ?? Database.batch
  const [changed, current] = await batch((db) => [
    db
      .update(AccountDeletionTable)
      .set({
        status: "cancelled",
        last_error_code: null,
        time_started: null,
        time_cancelled: new Date(now),
        timeUpdated: new Date(now),
      })
      .where(
        and(
          eq(AccountDeletionTable.account_id, value.accountID),
          inArray(AccountDeletionTable.status, ["requested", "failed"]),
          isNull(AccountDeletionTable.timeDeleted),
        ),
      )
      .returning(),
    findQuery(db, value.accountID),
  ])
  const row = changed[0] ?? current[0]
  if (!row) throw new AccountDeletionError("not_found")
  if (row.status === "processing" || row.status === "completed") throw new AccountDeletionError("too_late")
  return state(row, Boolean(changed[0]))
}

export async function getAccountDeletion(
  input: z.input<typeof AccountInput>,
  dependencies: {
    use?: Use
  } = {},
) {
  const value = AccountInput.parse(input)
  const use = dependencies.use ?? ((callback) => Database.use(callback))
  const row = await use((db) => find(db, value.accountID))
  return row ? state(row, false) : undefined
}

export async function processEligibleAccountDeletions(
  input: {
    now: number
    limit?: number
  },
  dependencies: {
    use?: Use
    transaction?: Transaction
    remove?: Remove
  } = {},
) {
  const now = timestamp(input.now)
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Бүртгэл устгах багцын хязгаар буруу байна")
  }
  const use = dependencies.use ?? ((callback) => Database.use(callback))
  const transaction = dependencies.transaction ?? ((callback) => Database.transaction(callback))
  const remove = dependencies.remove ?? Account.removeByID
  const date = new Date(now)
  const candidates = await use((db) =>
    db
      .select({ id: AccountDeletionTable.id })
      .from(AccountDeletionTable)
      .where(
        and(
          inArray(AccountDeletionTable.status, ["requested", "failed"]),
          lte(AccountDeletionTable.time_eligible, date),
          lt(AccountDeletionTable.attempts, ACCOUNT_DELETION_MAX_ATTEMPTS),
          isNull(AccountDeletionTable.timeDeleted),
        ),
      )
      .orderBy(asc(AccountDeletionTable.time_eligible), asc(AccountDeletionTable.id))
      .limit(limit),
  )

  let processed = 0
  let failed = 0
  let skipped = 0
  for (const candidate of candidates) {
    try {
      const changed = await transaction(async (db) => {
        const claimed = await db
          .update(AccountDeletionTable)
          .set({
            status: "processing",
            attempts: sql`${AccountDeletionTable.attempts} + 1`,
            last_error_code: null,
            time_started: date,
            timeUpdated: date,
          })
          .where(
            and(
              eq(AccountDeletionTable.id, candidate.id),
              inArray(AccountDeletionTable.status, ["requested", "failed"]),
              lte(AccountDeletionTable.time_eligible, date),
              lt(AccountDeletionTable.attempts, ACCOUNT_DELETION_MAX_ATTEMPTS),
              isNull(AccountDeletionTable.timeDeleted),
            ),
          )
          .returning({
            accountID: AccountDeletionTable.account_id,
          })
          .then((rows) => rows[0])
        if (!claimed) return false

        await assertSharedWorkspacesKeepAdministrator(db, claimed.accountID)
        await remove(db, { accountID: claimed.accountID, now: date })
        await db
          .update(AccountDeletionTable)
          .set({
            status: "completed",
            last_error_code: null,
            time_completed: date,
            timeUpdated: date,
          })
          .where(and(eq(AccountDeletionTable.id, candidate.id), eq(AccountDeletionTable.status, "processing")))
        return true
      })
      if (changed) processed++
      else skipped++
    } catch {
      const marked = await transaction((db) => markFailure(db, candidate.id, now))
      if (marked) failed++
      else skipped++
    }
  }
  return { processed, failed, skipped, truncated: candidates.length === limit }
}

export async function purgeCompletedAccountDeletions(
  input: {
    now: number
    limit?: number
  },
  dependencies: {
    use?: Use
    transaction?: Transaction
  } = {},
) {
  const now = timestamp(input.now)
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Бүртгэл устгах цэвэрлэгээний багцын хязгаар буруу байна")
  }
  const use = dependencies.use ?? ((callback) => Database.use(callback))
  const transaction = dependencies.transaction ?? ((callback) => Database.transaction(callback))
  const cutoff = new Date(now - ACCOUNT_DELETION_OPERATIONAL_RETENTION_MS)
  const date = new Date(now)
  const candidates = await use((db) =>
    db
      .select({ id: AccountDeletionTable.id, accountID: AccountDeletionTable.account_id })
      .from(AccountDeletionTable)
      .where(
        and(
          eq(AccountDeletionTable.status, "completed"),
          lte(AccountDeletionTable.time_completed, cutoff),
          isNull(AccountDeletionTable.timeDeleted),
        ),
      )
      .orderBy(asc(AccountDeletionTable.time_completed), asc(AccountDeletionTable.id))
      .limit(limit),
  )

  let purged = 0
  let skipped = 0
  for (const candidate of candidates) {
    const changed = await transaction(async (db) => {
      const account = await db
        .select({ timeDeleted: AccountTable.timeDeleted })
        .from(AccountTable)
        .where(eq(AccountTable.id, candidate.accountID))
        .limit(1)
        .then((rows) => rows[0])
      if (account && !account.timeDeleted) return false

      const detached = await db
        .update(AccountDeletionTable)
        .set({
          account_id: Identifier.create("account"),
          timeDeleted: date,
          timeUpdated: date,
        })
        .where(
          and(
            eq(AccountDeletionTable.id, candidate.id),
            eq(AccountDeletionTable.account_id, candidate.accountID),
            eq(AccountDeletionTable.status, "completed"),
            lte(AccountDeletionTable.time_completed, cutoff),
            isNull(AccountDeletionTable.timeDeleted),
          ),
        )
        .returning({ id: AccountDeletionTable.id })
        .then((rows) => rows[0])
      if (!detached) return false

      await db
        .delete(AccountTable)
        .where(and(eq(AccountTable.id, candidate.accountID), isNotNull(AccountTable.timeDeleted)))
      return true
    })
    if (changed) purged++
    else skipped++
  }
  return { purged, skipped, truncated: candidates.length === limit }
}

async function assertSharedWorkspacesKeepAdministrator(db: Database.TxOrDb, accountID: string) {
  if ((await blockingWorkspace(db, accountID))[0]) throw new AccountDeletionError("workspace_admin_required")
}

function blockingWorkspace(db: Database.TxOrDb, accountID: string) {
  const other = alias(UserTable, "other_member")
  const otherMember = and(
    eq(other.workspaceID, UserTable.workspaceID),
    ne(other.accountID, accountID),
    isNull(other.timeDeleted),
  )
  return db
    .select({ workspaceID: UserTable.workspaceID })
    .from(UserTable)
    .where(
      and(
        eq(UserTable.accountID, accountID),
        eq(UserTable.role, "admin"),
        isNull(UserTable.timeDeleted),
        exists(db.select({ id: other.id }).from(other).where(otherMember)),
        notExists(
          db
            .select({ id: other.id })
            .from(other)
            .where(and(otherMember, eq(other.role, "admin"))),
        ),
      ),
    )
    .limit(1)
}

async function markFailure(db: Database.TxOrDb, id: string, now: number) {
  const date = new Date(now)
  const current = await db
    .select({
      status: AccountDeletionTable.status,
      attempts: AccountDeletionTable.attempts,
    })
    .from(AccountDeletionTable)
    .where(and(eq(AccountDeletionTable.id, id), isNull(AccountDeletionTable.timeDeleted)))
    .limit(1)
    .then((rows) => rows[0])
  if (!current || current.status === "completed" || current.status === "cancelled") return false
  const attempts = current.status === "processing" ? current.attempts : current.attempts + 1
  if (attempts > ACCOUNT_DELETION_MAX_ATTEMPTS) return false

  return db
    .update(AccountDeletionTable)
    .set({
      status: "failed",
      attempts,
      last_error_code: "account_cleanup_failed",
      time_started: date,
      time_eligible: new Date(now + ACCOUNT_DELETION_RETRY_MS),
      timeUpdated: date,
    })
    .where(
      and(
        eq(AccountDeletionTable.id, id),
        eq(AccountDeletionTable.status, current.status),
        eq(AccountDeletionTable.attempts, current.attempts),
        isNull(AccountDeletionTable.timeDeleted),
      ),
    )
    .returning({ id: AccountDeletionTable.id })
    .then((rows) => Boolean(rows[0]))
}

function find(db: Database.TxOrDb, accountID: string) {
  return findQuery(db, accountID).then((rows) => rows[0])
}

function findQuery(db: Database.TxOrDb, accountID: string) {
  return db
    .select()
    .from(AccountDeletionTable)
    .where(and(eq(AccountDeletionTable.account_id, accountID), isNull(AccountDeletionTable.timeDeleted)))
    .limit(1)
}

function state(row: typeof AccountDeletionTable.$inferSelect, changed: boolean) {
  return {
    id: row.id,
    accountID: row.account_id,
    status: row.status,
    attempts: row.attempts,
    eligibleAt: row.time_eligible.getTime(),
    completedAt: row.time_completed?.getTime(),
    cancelledAt: row.time_cancelled?.getTime(),
    changed,
  }
}

function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Бүртгэл устгах хугацаа буруу байна")
  return value
}
