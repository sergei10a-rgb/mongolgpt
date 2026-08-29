import { z } from "zod"
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm"
import { fn } from "./util/fn"
import { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { AccountTable } from "./schema/account.sql"
import { AuthTable } from "./schema/auth.sql"
import { UserTable } from "./schema/user.sql"
import { KeyTable } from "./schema/key.sql"
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
import { KeyRateLimitTable } from "./schema/ip.sql"
import { ModelTable } from "./schema/model.sql"
import { ProviderTable } from "./schema/provider.sql"
import { ReferralCodeTable, ReferralTable } from "./schema/referral.sql"
import { WorkspaceTable } from "./schema/workspace.sql"
import { NewsletterSubscriberTable } from "./schema-d1"

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
      if (!account) throw new Error("Бүртгэл олдсонгүй")

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
      .select({ id: UserTable.id, workspaceID: UserTable.workspaceID })
      .from(UserTable)
      .where(and(eq(UserTable.accountID, account.id), isNull(UserTable.timeDeleted)))
    const userIDs = users.map((user) => user.id)
    const workspaceIDs = [...new Set(users.map((user) => user.workspaceID))]
    const soleWorkspaceIDs: string[] = []
    for (const workspaceID of workspaceIDs) {
      const other = await tx
        .select({ id: UserTable.id })
        .from(UserTable)
        .where(
          and(
            eq(UserTable.workspaceID, workspaceID),
            ne(UserTable.accountID, account.id),
            isNotNull(UserTable.accountID),
            isNull(UserTable.timeDeleted),
          ),
        )
        .limit(1)
        .then((rows) => rows[0])
      if (!other) soleWorkspaceIDs.push(workspaceID)
    }

    const keys = new Map<string, { id: string; key: string }>()
    if (userIDs.length > 0) {
      const rows = await tx
        .select({ id: KeyTable.id, key: KeyTable.key })
        .from(KeyTable)
        .where(and(inArray(KeyTable.userID, userIDs), isNull(KeyTable.timeDeleted)))
      for (const row of rows) keys.set(row.id, row)
    }
    if (soleWorkspaceIDs.length > 0) {
      const rows = await tx
        .select({ id: KeyTable.id, key: KeyTable.key })
        .from(KeyTable)
        .where(and(inArray(KeyTable.workspaceID, soleWorkspaceIDs), isNull(KeyTable.timeDeleted)))
      for (const row of rows) keys.set(row.id, row)
    }
    const keyRows = [...keys.values()]
    if (keyRows.length > 0) {
      await tx.delete(KeyRateLimitTable).where(
        inArray(
          KeyRateLimitTable.key,
          keyRows.map((row) => row.key),
        ),
      )
      await tx
        .update(UsageTable)
        .set({ keyID: null, sessionID: null, timeUpdated: input.now })
        .where(
          inArray(
            UsageTable.keyID,
            keyRows.map((row) => row.id),
          ),
        )
    }
    if (userIDs.length > 0) {
      await tx
        .update(UsageTable)
        .set({ userID: null, sessionID: null, timeUpdated: input.now })
        .where(inArray(UsageTable.userID, userIDs))
    }
    const revokedApiKeys =
      keyRows.length === 0
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
            .where(
              and(
                inArray(
                  KeyTable.id,
                  keyRows.map((row) => row.id),
                ),
                isNull(KeyTable.timeDeleted),
              ),
            )
            .returning({ id: KeyTable.id })

    if (userIDs.length > 0) {
      await tx
        .update(SubscriptionTable)
        .set({ timeDeleted: input.now, timeUpdated: input.now })
        .where(and(inArray(SubscriptionTable.userID, userIDs), isNull(SubscriptionTable.timeDeleted)))
      await tx
        .update(LiteTable)
        .set({ timeDeleted: input.now, timeUpdated: input.now })
        .where(and(inArray(LiteTable.userID, userIDs), isNull(LiteTable.timeDeleted)))
    }
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

    const pseudonymousAccountID = Identifier.create("account")
    await pseudonymizeAccountReferences(tx, {
      accountID: account.id,
      pseudonymousAccountID,
      soleWorkspaceIDs,
      now: input.now,
    })
    await cleanSoleWorkspaces(tx, soleWorkspaceIDs, input.now)

    if (emails.length > 0) {
      await tx.delete(CouponTable).where(
        inArray(
          CouponTable.email,
          emails.map((row) => row.email),
        ),
      )
      await tx.delete(NewsletterSubscriberTable).where(
        inArray(
          NewsletterSubscriberTable.email,
          emails.map((row) => row.email),
        ),
      )
    }
    await tx.delete(AuthTable).where(eq(AuthTable.accountID, account.id))
    const deleted = await tx
      .update(AccountTable)
      .set({
        status: "active",
        suspension_reason: null,
        suspended_by: null,
        time_suspended: null,
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

  async function pseudonymizeAccountReferences(
    tx: Database.TxOrDb,
    input: {
      accountID: string
      pseudonymousAccountID: string
      soleWorkspaceIDs: string[]
      now: Date
    },
  ) {
    const checkouts = new Map<
      string,
      {
        id: string
        workspaceID: string
        provider: "qpay" | "bonum"
        merchantAccountID: string
        externalInvoiceID: string | null
        status: typeof PaymentCheckoutTable.$inferSelect.status
      }
    >()
    const checkoutColumns = {
      id: PaymentCheckoutTable.id,
      workspaceID: PaymentCheckoutTable.workspace_id,
      provider: PaymentCheckoutTable.provider,
      merchantAccountID: PaymentCheckoutTable.merchant_account_id,
      externalInvoiceID: PaymentCheckoutTable.external_invoice_id,
      status: PaymentCheckoutTable.status,
    }
    for (const row of await tx
      .select(checkoutColumns)
      .from(PaymentCheckoutTable)
      .where(eq(PaymentCheckoutTable.account_id, input.accountID))) {
      checkouts.set(row.id, row)
    }
    if (input.soleWorkspaceIDs.length > 0) {
      for (const row of await tx
        .select(checkoutColumns)
        .from(PaymentCheckoutTable)
        .where(inArray(PaymentCheckoutTable.workspace_id, input.soleWorkspaceIDs))) {
        checkouts.set(row.id, row)
      }
    }
    for (const row of checkouts.values()) {
      const soleWorkspace = input.soleWorkspaceIDs.includes(row.workspaceID)
      const reference = {
        account_id: input.pseudonymousAccountID,
        request_key: `deleted:${row.id}`,
        timeUpdated: input.now,
      }
      if (!soleWorkspace) {
        await tx.update(PaymentCheckoutTable).set(reference).where(eq(PaymentCheckoutTable.id, row.id))
        continue
      }
      const checkout = row.externalInvoiceID
        ? {
            provider: row.provider,
            merchantAccountID: row.merchantAccountID,
            externalInvoiceID: row.externalInvoiceID,
            deepLinks: [],
          }
        : null
      const base = {
        ...reference,
        checkout,
        creation_error_code: null,
      }
      if (row.status === "creating" || row.status === "unknown") {
        await tx
          .update(PaymentCheckoutTable)
          .set({ ...base, status: "expired", time_expired: input.now })
          .where(eq(PaymentCheckoutTable.id, row.id))
        continue
      }
      if (row.status === "ready" || row.status === "pending") {
        await tx
          .update(PaymentCheckoutTable)
          .set({ ...base, status: "cancelled", time_cancelled: input.now })
          .where(eq(PaymentCheckoutTable.id, row.id))
        continue
      }
      await tx.update(PaymentCheckoutTable).set(base).where(eq(PaymentCheckoutTable.id, row.id))
    }

    const cancellations = new Map<
      string,
      { invoiceID: string; workspaceID: string; status: typeof PaymentCancellationTable.$inferSelect.status }
    >()
    const cancellationColumns = {
      invoiceID: PaymentCancellationTable.invoice_id,
      workspaceID: PaymentCancellationTable.workspace_id,
      status: PaymentCancellationTable.status,
    }
    for (const row of await tx
      .select(cancellationColumns)
      .from(PaymentCancellationTable)
      .where(eq(PaymentCancellationTable.account_id, input.accountID))) {
      cancellations.set(row.invoiceID, row)
    }
    if (input.soleWorkspaceIDs.length > 0) {
      for (const row of await tx
        .select(cancellationColumns)
        .from(PaymentCancellationTable)
        .where(inArray(PaymentCancellationTable.workspace_id, input.soleWorkspaceIDs))) {
        cancellations.set(row.invoiceID, row)
      }
    }
    for (const row of cancellations.values()) {
      const base = {
        account_id: input.pseudonymousAccountID,
        request_key: `deleted:${row.invoiceID}`,
        timeUpdated: input.now,
      }
      if (!input.soleWorkspaceIDs.includes(row.workspaceID)) {
        await tx
          .update(PaymentCancellationTable)
          .set(base)
          .where(eq(PaymentCancellationTable.invoice_id, row.invoiceID))
        continue
      }
      if (row.status === "requested" || row.status === "unknown") {
        await tx
          .update(PaymentCancellationTable)
          .set({ ...base, status: "failed", error_code: "account_deleted", time_completed: input.now })
          .where(eq(PaymentCancellationTable.invoice_id, row.invoiceID))
        continue
      }
      await tx.update(PaymentCancellationTable).set(base).where(eq(PaymentCancellationTable.invoice_id, row.invoiceID))
    }

    await tx
      .update(ReferralTable)
      .set({
        inviteeAccountID: input.pseudonymousAccountID,
        timeDeleted: input.now,
        timeUpdated: input.now,
      })
      .where(eq(ReferralTable.inviteeAccountID, input.accountID))
  }

  async function cleanSoleWorkspaces(tx: Database.TxOrDb, workspaceIDs: string[], now: Date) {
    if (workspaceIDs.length === 0) return

    await tx
      .update(UsageTable)
      .set({ userID: null, keyID: null, sessionID: null, timeUpdated: now })
      .where(inArray(UsageTable.workspaceID, workspaceIDs))
    await tx
      .update(SubscriptionTable)
      .set({ timeDeleted: now, timeUpdated: now })
      .where(and(inArray(SubscriptionTable.workspaceID, workspaceIDs), isNull(SubscriptionTable.timeDeleted)))
    await tx
      .update(LiteTable)
      .set({ timeDeleted: now, timeUpdated: now })
      .where(and(inArray(LiteTable.workspaceID, workspaceIDs), isNull(LiteTable.timeDeleted)))
    await tx
      .update(ProviderTable)
      .set({ credentials: "", timeDeleted: now, timeUpdated: now })
      .where(and(inArray(ProviderTable.workspaceID, workspaceIDs), isNull(ProviderTable.timeDeleted)))
    await tx
      .update(ModelTable)
      .set({ timeDeleted: now, timeUpdated: now })
      .where(and(inArray(ModelTable.workspaceID, workspaceIDs), isNull(ModelTable.timeDeleted)))
    await tx
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
      .where(and(inArray(BillingTable.workspaceID, workspaceIDs), isNull(BillingTable.timeDeleted)))
    await tx
      .update(PlanSubscriptionTable)
      .set({ status: "cancelled", timeCancelled: now, timeUpdated: now })
      .where(
        and(
          inArray(PlanSubscriptionTable.workspaceID, workspaceIDs),
          eq(PlanSubscriptionTable.status, "active"),
          isNull(PlanSubscriptionTable.timeDeleted),
        ),
      )
    await tx.delete(ReferralCodeTable).where(inArray(ReferralCodeTable.workspaceID, workspaceIDs))
    await tx.delete(ReferralTable).where(inArray(ReferralTable.workspaceID, workspaceIDs))
    await tx
      .update(UserTable)
      .set({ accountID: null, email: null, name: "", timeDeleted: now, timeUpdated: now })
      .where(and(inArray(UserTable.workspaceID, workspaceIDs), isNull(UserTable.timeDeleted)))
    await tx
      .update(WorkspaceTable)
      .set({ slug: null, name: "", timeDeleted: now, timeUpdated: now })
      .where(and(inArray(WorkspaceTable.id, workspaceIDs), isNull(WorkspaceTable.timeDeleted)))
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
