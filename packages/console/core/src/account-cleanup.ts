import { and, eq, exists, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm"
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import type { Database } from "./drizzle"
import { AccountTable, AccountDeletionCleanupTable, NewsletterSubscriberTable } from "./schema-d1"
import { AuthTable } from "./schema/auth.sql"
import { UserTable } from "./schema/user.sql"
import { KeyTable } from "./schema/key.sql"
import { KeyRateLimitTable } from "./schema/ip.sql"
import { WorkspaceTable } from "./schema/workspace.sql"
import { ProviderTable } from "./schema/provider.sql"
import { ModelTable } from "./schema/model.sql"
import { ReferralCodeTable, ReferralTable } from "./schema/referral.sql"
import {
  BillingTable,
  CouponTable,
  LiteTable,
  PaymentCancellationTable,
  PaymentCheckoutTable,
  PlanSubscriptionTable,
  SubscriptionTable,
  UsageTable,
} from "./schema/billing.sql"

// Deferred statements run in the coordinator's single D1 batch. Identity-bearing
// rows stay intact until every dependent update has used their subqueries.
export function accountCleanupStatements(
  db: Parameters<Parameters<typeof Database.batch>[0]>[0],
  input: { accountID: string; pseudonymousAccountID: string; requestID: string; leaseID: string; now: Date },
) {
  const now = input.now
  const guard = sql`exists (select 1 from ${AccountDeletionCleanupTable}
    where ${AccountDeletionCleanupTable.request_id} = ${input.requestID}
      and ${AccountDeletionCleanupTable.account_id} = ${input.accountID}
      and ${AccountDeletionCleanupTable.lease_id} = ${input.leaseID}
      and ${AccountDeletionCleanupTable.time_lease_expires} > ${now.getTime()}
      and ${AccountDeletionCleanupTable.time_runtime_completed} is not null
      and ${AccountDeletionCleanupTable.time_completed} is null)`
  const { ownedUser, sole, keyScope } = accountCleanupScope(db, input.accountID)
  const ownedUsageKey = exists(
    db
      .select({ id: KeyTable.id })
      .from(KeyTable)
      .where(and(eq(KeyTable.id, UsageTable.keyID), eq(KeyTable.workspaceID, UsageTable.workspaceID), keyScope)),
  )
  const emails = db
    .select({ email: AuthTable.subject })
    .from(AuthTable)
    .where(and(eq(AuthTable.accountID, input.accountID), eq(AuthTable.provider, "email")))
  const checkoutSole = inArray(PaymentCheckoutTable.workspace_id, sole)
  const cancellationSole = inArray(PaymentCancellationTable.workspace_id, sole)
  return [
    db
      .delete(KeyRateLimitTable)
      .where(
        and(guard, inArray(KeyRateLimitTable.key, db.select({ key: KeyTable.key }).from(KeyTable).where(keyScope))),
      ),
    db.update(UsageTable).set({ keyID: null, sessionID: null, timeUpdated: now }).where(and(guard, ownedUsageKey)),
    db
      .update(UsageTable)
      .set({ userID: null, sessionID: null, timeUpdated: now })
      .where(and(guard, ownedUser(UsageTable.userID, UsageTable.workspaceID))),
    db
      .update(UsageTable)
      .set({ userID: null, keyID: null, sessionID: null, timeUpdated: now })
      .where(and(guard, inArray(UsageTable.workspaceID, sole))),
    db
      .update(KeyTable)
      .set({
        name: "",
        key: sql`'revoked:' || length(${KeyTable.workspaceID}) || ':' || ${KeyTable.workspaceID} || ':' || ${KeyTable.id}`,
        timeUsed: null,
        timeDeleted: now,
        timeUpdated: now,
      })
      .where(and(guard, keyScope)),
    db
      .update(SubscriptionTable)
      .set({ timeDeleted: now, timeUpdated: now })
      .where(
        and(
          guard,
          or(
            ownedUser(SubscriptionTable.userID, SubscriptionTable.workspaceID),
            inArray(SubscriptionTable.workspaceID, sole),
          ),
        ),
      ),
    db
      .update(LiteTable)
      .set({ timeDeleted: now, timeUpdated: now })
      .where(and(guard, or(ownedUser(LiteTable.userID, LiteTable.workspaceID), inArray(LiteTable.workspaceID, sole)))),
    db
      .update(PaymentCheckoutTable)
      .set({
        account_id: input.pseudonymousAccountID,
        request_key: sql`'deleted:' || ${PaymentCheckoutTable.id}`,
        checkout: sql`case when ${checkoutSole} then case when ${PaymentCheckoutTable.external_invoice_id} is null then null
        else json_object('provider', ${PaymentCheckoutTable.provider}, 'merchantAccountID', ${PaymentCheckoutTable.merchant_account_id},
          'externalInvoiceID', ${PaymentCheckoutTable.external_invoice_id}, 'deepLinks', json('[]')) end else ${PaymentCheckoutTable.checkout} end`,
        creation_error_code: sql`case when ${checkoutSole} then null else ${PaymentCheckoutTable.creation_error_code} end`,
        status: sql`case when ${checkoutSole} and ${PaymentCheckoutTable.status} in ('creating', 'unknown') then 'expired'
        when ${checkoutSole} and ${PaymentCheckoutTable.status} in ('ready', 'pending') then 'cancelled' else ${PaymentCheckoutTable.status} end`,
        time_expired: sql`case when ${checkoutSole} and ${PaymentCheckoutTable.status} in ('creating', 'unknown') then ${now.getTime()} else ${PaymentCheckoutTable.time_expired} end`,
        time_cancelled: sql`case when ${checkoutSole} and ${PaymentCheckoutTable.status} in ('ready', 'pending') then ${now.getTime()} else ${PaymentCheckoutTable.time_cancelled} end`,
        timeUpdated: now,
      })
      .where(and(guard, or(eq(PaymentCheckoutTable.account_id, input.accountID), checkoutSole))),
    db
      .update(PaymentCancellationTable)
      .set({
        account_id: input.pseudonymousAccountID,
        request_key: sql`'deleted:' || ${PaymentCancellationTable.invoice_id}`,
        status: sql`case when ${cancellationSole} and ${PaymentCancellationTable.status} in ('requested', 'unknown') then 'failed' else ${PaymentCancellationTable.status} end`,
        error_code: sql`case when ${cancellationSole} and ${PaymentCancellationTable.status} in ('requested', 'unknown') then 'account_deleted' else ${PaymentCancellationTable.error_code} end`,
        time_completed: sql`case when ${cancellationSole} and ${PaymentCancellationTable.status} in ('requested', 'unknown') then ${now.getTime()} else ${PaymentCancellationTable.time_completed} end`,
        timeUpdated: now,
      })
      .where(and(guard, or(eq(PaymentCancellationTable.account_id, input.accountID), cancellationSole))),
    db
      .update(ReferralTable)
      .set({ inviteeAccountID: input.pseudonymousAccountID, timeDeleted: now, timeUpdated: now })
      .where(and(guard, eq(ReferralTable.inviteeAccountID, input.accountID))),
    db
      .update(ProviderTable)
      .set({ credentials: "", timeDeleted: now, timeUpdated: now })
      .where(and(guard, inArray(ProviderTable.workspaceID, sole))),
    db
      .update(ModelTable)
      .set({ timeDeleted: now, timeUpdated: now })
      .where(and(guard, inArray(ModelTable.workspaceID, sole))),
    db
      .update(BillingTable)
      .set({
        customerID: null,
        paymentMethodID: null,
        paymentMethodType: null,
        paymentMethodLast4: null,
        subscription: null,
        subscriptionID: null,
        subscriptionPlan: null,
        liteSubscriptionID: null,
        lite: null,
        reload: null,
        reloadTrigger: null,
        reloadAmount: null,
        reloadError: null,
        timeReloadError: null,
        timeReloadLockedTill: null,
        timeDeleted: now,
        timeUpdated: now,
      })
      .where(and(guard, inArray(BillingTable.workspaceID, sole))),
    db
      .update(PlanSubscriptionTable)
      .set({ status: "cancelled", timeCancelled: now, timeUpdated: now })
      .where(
        and(
          guard,
          inArray(PlanSubscriptionTable.workspaceID, sole),
          eq(PlanSubscriptionTable.status, "active"),
          isNull(PlanSubscriptionTable.timeDeleted),
        ),
      ),
    db.delete(ReferralCodeTable).where(and(guard, inArray(ReferralCodeTable.workspaceID, sole))),
    db.delete(ReferralTable).where(and(guard, inArray(ReferralTable.workspaceID, sole))),
    db.delete(CouponTable).where(and(guard, inArray(CouponTable.email, emails))),
    db.delete(NewsletterSubscriberTable).where(and(guard, inArray(NewsletterSubscriberTable.email, emails))),
    db
      .update(WorkspaceTable)
      .set({ slug: null, name: "", timeDeleted: now, timeUpdated: now })
      .where(and(guard, inArray(WorkspaceTable.id, sole))),
    // Invitations in sole workspaces must be scrubbed before owner memberships disappear.
    db
      .update(UserTable)
      .set({ email: null, name: "", timeDeleted: now, timeUpdated: now })
      .where(and(guard, inArray(UserTable.workspaceID, sole), isNull(UserTable.accountID))),
    db
      .update(UserTable)
      .set({ accountID: null, email: null, name: "", timeDeleted: now, timeUpdated: now })
      .where(and(guard, eq(UserTable.accountID, input.accountID))),
    db.delete(AuthTable).where(and(guard, eq(AuthTable.accountID, input.accountID))),
    db
      .update(AccountTable)
      .set({ status: "active", suspension_reason: null, suspended_by: null, time_suspended: null, timeUpdated: now })
      .where(and(guard, eq(AccountTable.id, input.accountID))),
  ] as const
}

export function accountCleanupScope(db: Database.TxOrDb, accountID: string) {
  // Member and key IDs are unique only inside a workspace, not across tenants.
  const ownedUser = (id: AnySQLiteColumn, workspaceID: AnySQLiteColumn) =>
    exists(
      db
        .select({ id: UserTable.id })
        .from(UserTable)
        .where(and(eq(UserTable.accountID, accountID), eq(UserTable.id, id), eq(UserTable.workspaceID, workspaceID))),
    )
  const other = alias(UserTable, "remaining_member")
  const sole = db
    .select({ id: UserTable.workspaceID })
    .from(UserTable)
    .where(
      and(
        eq(UserTable.accountID, accountID),
        notExists(
          db
            .select({ id: other.id })
            .from(other)
            .where(
              and(
                eq(other.workspaceID, UserTable.workspaceID),
                ne(other.accountID, accountID),
                isNull(other.timeDeleted),
                exists(
                  db
                    .select({ id: AccountTable.id })
                    .from(AccountTable)
                    .where(and(eq(AccountTable.id, other.accountID), isNull(AccountTable.timeDeleted))),
                ),
              ),
            ),
        ),
      ),
    )
  return {
    ownedUser,
    sole,
    keyScope: or(ownedUser(KeyTable.userID, KeyTable.workspaceID), inArray(KeyTable.workspaceID, sole)),
  }
}
