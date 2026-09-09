import { and, asc, eq, inArray, isNull, lt, lte, notExists, or, sql } from "drizzle-orm"
import { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { AccountTable, AccountDeletionTable, AccountDeletionCleanupTable, UserTable, KeyTable } from "./schema-d1"
import { accountCleanupScope, accountCleanupStatements } from "./account-cleanup"
import { ACCOUNT_DELETION_MAX_ATTEMPTS, ACCOUNT_DELETION_RETRY_MS, blockingWorkspace } from "./account-deletion"

export type RuntimeAccountCleanup = (input: {
  requestID: string
  accountID: string
  workspaceIDs: string[]
}) => Promise<{ requestID: string; accountID: string; complete: true }>

const LEASE_MS = 15 * 60_000

export async function processEligibleAccountDeletions(
  input: { now: number; limit?: number },
  dependencies: {
    use?: typeof Database.use
    batch?: typeof Database.batch
    runtime?: RuntimeAccountCleanup
    clock?: () => number
  } = {},
) {
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("Бүртгэл устгах багцын хугацаа эсвэл хязгаар буруу байна")
  // Configuration must be present before an account becomes irreversibly inaccessible.
  if (!dependencies.runtime) throw new Error("Cloud өгөгдөл цэвэрлэх холболт тохируулаагүй байна")
  const runtime = dependencies.runtime
  const use = dependencies.use ?? Database.use
  const batch = dependencies.batch ?? Database.batch
  const clock = dependencies.clock ?? Date.now
  const date = new Date(input.now)
  const candidates = await use((db) =>
    db
      .select({ id: AccountDeletionTable.id, accountID: AccountDeletionTable.account_id })
      .from(AccountDeletionTable)
      .where(
        and(
          isNull(AccountDeletionTable.timeDeleted),
          or(
            and(
              inArray(AccountDeletionTable.status, ["requested", "failed"]),
              lte(AccountDeletionTable.time_eligible, date),
              lt(AccountDeletionTable.attempts, ACCOUNT_DELETION_MAX_ATTEMPTS),
            ),
            and(
              eq(AccountDeletionTable.status, "processing"),
              sql`exists (select 1 from ${AccountDeletionCleanupTable}
        where ${AccountDeletionCleanupTable.request_id} = ${AccountDeletionTable.id}
          and ${AccountDeletionCleanupTable.time_next_attempt} <= ${clock()}
          and (${AccountDeletionCleanupTable.time_lease_expires} is null or ${AccountDeletionCleanupTable.time_lease_expires} <= ${clock()})
          and ${AccountDeletionCleanupTable.time_completed} is null)`,
            ),
          ),
        ),
      )
      .orderBy(asc(AccountDeletionTable.time_eligible), asc(AccountDeletionTable.id))
      .limit(limit),
  )

  let processed = 0
  let failed = 0
  let skipped = 0
  for (const candidate of candidates) {
    const leaseID = crypto.randomUUID()
    const started = new Date(clock())
    const claimed = await batch((db) => {
      const processing = sql`exists (select 1 from ${AccountDeletionTable}
        where ${AccountDeletionTable.id} = ${candidate.id} and ${AccountDeletionTable.account_id} = ${candidate.accountID} and ${AccountDeletionTable.status} = 'processing')`
      const cleanup = sql`exists (select 1 from ${AccountDeletionCleanupTable}
        where ${AccountDeletionCleanupTable.request_id} = ${candidate.id}
          and ${AccountDeletionCleanupTable.account_id} = ${candidate.accountID})`
      return [
        db
          .update(AccountDeletionTable)
          .set({
            status: "processing",
            attempts: sql`${AccountDeletionTable.attempts} + 1`,
            last_error_code: null,
            time_started: started,
            timeUpdated: started,
          })
          .where(
            and(
              eq(AccountDeletionTable.id, candidate.id),
              eq(AccountDeletionTable.account_id, candidate.accountID),
              inArray(AccountDeletionTable.status, ["requested", "failed"]),
              lte(AccountDeletionTable.time_eligible, date),
              lt(AccountDeletionTable.attempts, ACCOUNT_DELETION_MAX_ATTEMPTS),
              isNull(AccountDeletionTable.timeDeleted),
              notExists(blockingWorkspace(db, candidate.accountID)),
            ),
          ),
        db
          .insert(AccountDeletionCleanupTable)
          .select(
            db
              .select({
                request_id: AccountDeletionTable.id,
                account_id: AccountDeletionTable.account_id,
                workspace_ids: sql<
                  string[]
                >`(select json_group_array(distinct ${UserTable.workspaceID}) from ${UserTable} where ${UserTable.accountID} = ${candidate.accountID})`.as(
                  "workspace_ids",
                ),
                pseudonymous_account_id: sql<string>`${Identifier.create("account")}`.as("pseudonymous_account_id"),
                attempts: sql<number>`0`.as("attempts"),
                lease_id: sql<null>`null`.as("lease_id"),
                time_lease_expires: sql<null>`null`.as("time_lease_expires"),
                time_next_attempt: sql<Date>`${started.getTime()}`.as("time_next_attempt"),
                time_runtime_completed: sql<null>`null`.as("time_runtime_completed"),
                time_completed: sql<null>`null`.as("time_completed"),
                last_error_code: sql<null>`null`.as("last_error_code"),
                timeCreated: sql<Date>`${started.getTime()}`.as("time_created"),
                timeUpdated: sql<Date>`${started.getTime()}`.as("time_updated"),
                timeDeleted: sql<null>`null`.as("time_deleted"),
              })
              .from(AccountDeletionTable)
              .where(
                and(
                  eq(AccountDeletionTable.id, candidate.id),
                  eq(AccountDeletionTable.account_id, candidate.accountID),
                  eq(AccountDeletionTable.status, "processing"),
                  isNull(AccountDeletionTable.timeDeleted),
                ),
              ),
          )
          .onConflictDoNothing({ target: AccountDeletionCleanupTable.request_id }),
        db
          .update(AccountTable)
          .set({ timeDeleted: started, timeUpdated: started, auth_version: sql`${AccountTable.auth_version} + 1` })
          .where(and(eq(AccountTable.id, candidate.accountID), isNull(AccountTable.timeDeleted), processing, cleanup)),
        db
          .update(KeyTable)
          .set({ timeDeleted: started, timeUpdated: started })
          .where(
            and(
              processing,
              cleanup,
              isNull(KeyTable.timeDeleted),
              accountCleanupScope(db, candidate.accountID).keyScope,
            ),
          ),
        db
          .update(AccountDeletionCleanupTable)
          .set({
            lease_id: leaseID,
            time_lease_expires: new Date(started.getTime() + LEASE_MS),
            attempts: sql`${AccountDeletionCleanupTable.attempts} + 1`,
            last_error_code: null,
            timeUpdated: started,
          })
          .where(
            and(
              eq(AccountDeletionCleanupTable.request_id, candidate.id),
              processing,
              isNull(AccountDeletionCleanupTable.time_completed),
              lte(AccountDeletionCleanupTable.time_next_attempt, started),
              or(
                isNull(AccountDeletionCleanupTable.time_lease_expires),
                lte(AccountDeletionCleanupTable.time_lease_expires, started),
              ),
            ),
          )
          .returning(),
        db
          .update(AccountDeletionTable)
          .set({
            attempts: sql`min(5, (select ${AccountDeletionCleanupTable.attempts} from ${AccountDeletionCleanupTable} where ${AccountDeletionCleanupTable.request_id} = ${candidate.id}))`,
            timeUpdated: started,
          })
          .where(
            and(
              eq(AccountDeletionTable.id, candidate.id),
              processing,
              sql`exists (select 1 from ${AccountDeletionCleanupTable} where ${AccountDeletionCleanupTable.request_id} = ${candidate.id} and ${AccountDeletionCleanupTable.lease_id} = ${leaseID})`,
            ),
          ),
      ] as const
    }).then((results) => results[4][0])
    if (!claimed) {
      const rejected = await use((db) =>
        db
          .update(AccountDeletionTable)
          .set({
            status: "failed",
            attempts: sql`${AccountDeletionTable.attempts} + 1`,
            last_error_code: "account_cleanup_failed",
            time_started: started,
            time_eligible: new Date(started.getTime() + ACCOUNT_DELETION_RETRY_MS),
            timeUpdated: started,
          })
          .where(
            and(
              eq(AccountDeletionTable.id, candidate.id),
              inArray(AccountDeletionTable.status, ["requested", "failed"]),
              lt(AccountDeletionTable.attempts, ACCOUNT_DELETION_MAX_ATTEMPTS),
              lte(AccountDeletionTable.time_eligible, date),
              isNull(AccountDeletionTable.timeDeleted),
            ),
          )
          .returning({ id: AccountDeletionTable.id }),
      )
      if (rejected[0]) failed++
      else skipped++
      continue
    }

    let phase: "runtime_cleanup_failed" | "account_cleanup_failed" = "runtime_cleanup_failed"
    try {
      if (!claimed.time_runtime_completed) {
        const receipt = await runtime({
          requestID: candidate.id,
          accountID: claimed.account_id,
          workspaceIDs: claimed.workspace_ids,
        })
        if (
          receipt?.complete !== true ||
          receipt.requestID !== candidate.id ||
          receipt.accountID !== claimed.account_id
        )
          throw new Error("Invalid cleanup receipt")
        const confirmed = await use((db) =>
          db
            .update(AccountDeletionCleanupTable)
            .set({ time_runtime_completed: new Date(clock()), timeUpdated: new Date(clock()) })
            .where(lease(candidate.id, leaseID, clock()))
            .returning({ id: AccountDeletionCleanupTable.request_id }),
        )
        if (!confirmed[0]) {
          skipped++
          continue
        }
      }
      phase = "account_cleanup_failed"
      const completed = new Date(clock())
      const result = await batch(
        (db) =>
          [
            ...accountCleanupStatements(db, {
              accountID: claimed.account_id,
              pseudonymousAccountID: claimed.pseudonymous_account_id,
              requestID: candidate.id,
              leaseID,
              now: completed,
            }),
            db
              .update(AccountDeletionCleanupTable)
              .set({ time_completed: completed, last_error_code: null, timeUpdated: completed })
              .where(
                and(
                  lease(candidate.id, leaseID, completed.getTime()),
                  sql`${AccountDeletionCleanupTable.time_runtime_completed} is not null`,
                ),
              ),
            db
              .update(AccountDeletionTable)
              .set({ status: "completed", time_completed: completed, last_error_code: null, timeUpdated: completed })
              .where(
                and(
                  eq(AccountDeletionTable.id, candidate.id),
                  eq(AccountDeletionTable.status, "processing"),
                  sql`exists (select 1 from ${AccountDeletionCleanupTable} where ${AccountDeletionCleanupTable.request_id} = ${candidate.id}
            and ${AccountDeletionCleanupTable.lease_id} = ${leaseID} and ${AccountDeletionCleanupTable.time_completed} = ${completed.getTime()})`,
                ),
              )
              .returning({ id: AccountDeletionTable.id }),
          ] as const,
      )
      const final = result.at(-1)
      if (Array.isArray(final) && final[0]) processed++
      else skipped++
    } catch {
      // Runtime retirement cannot be rolled back. Keep processing uncancellable,
      // release only this lease, and retry without replaying acknowledged cleanup.
      const retried = await use((db) =>
        db
          .update(AccountDeletionCleanupTable)
          .set({
            lease_id: null,
            time_lease_expires: null,
            time_next_attempt: new Date(clock() + ACCOUNT_DELETION_RETRY_MS),
            last_error_code: phase,
            timeUpdated: new Date(clock()),
          })
          .where(lease(candidate.id, leaseID, clock()))
          .returning({ id: AccountDeletionCleanupTable.request_id }),
      )
      if (retried[0]) failed++
      else skipped++
    }
  }
  return { processed, failed, skipped, truncated: candidates.length === limit }
}

function lease(requestID: string, leaseID: string, now: number) {
  return and(
    eq(AccountDeletionCleanupTable.request_id, requestID),
    eq(AccountDeletionCleanupTable.lease_id, leaseID),
    sql`${AccountDeletionCleanupTable.time_lease_expires} > ${now}`,
    isNull(AccountDeletionCleanupTable.time_completed),
  )
}
