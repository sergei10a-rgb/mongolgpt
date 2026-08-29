import { z } from "zod"
import { AccountAccess } from "@mongolgpt/console-core/account-access.js"
import {
  and,
  count,
  countDistinct,
  Database,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  lt,
  max,
  min,
  or,
  sql,
  sum,
} from "@mongolgpt/console-core/drizzle/index.js"
import {
  calculateFinanceGrossMargin,
  getFinanceMarginEvidenceWithDb,
  type FinanceMarginEvidence,
} from "@mongolgpt/console-core/finance-reporting.js"
import {
  PaymentCheckoutTable,
  PaymentInvoiceTable,
  PlanSubscriptionTable,
  SubscriptionTable,
  UsageTable,
} from "@mongolgpt/console-core/schema/billing.sql.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import { AuthTable } from "@mongolgpt/console-core/schema/auth.sql.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import { Subscription } from "@mongolgpt/console-core/subscription.js"
import type { PlatformAdminContext } from "./admin-context"
import {
  AdminAuthorizationError,
  requirePlatformAdminPermission,
  writeAdminAudit,
  writeAdminAuditWithDb,
} from "./admin-auth"
import { AdminMutationRequestError, requireSameOriginAdminMutation } from "./admin-mutation"

const day = 86_400_000
const accountID = z.string().regex(/^acc_[0-9A-HJKMNP-TV-Z]{26}$/)

export const AdminUserDirectoryInput = z.object({
  q: z.string().trim().max(100).default(""),
  status: z.enum(["all", "active", "suspended"]).default("all"),
  cursor: accountID.optional(),
  limit: z.union([z.literal(25), z.literal(50)]).default(25),
})

export const AdminAccountStatusInput = z.object({
  accountID,
  operation: z.enum(["suspend", "reactivate"]),
  reason: AccountAccess.Reason,
})

export const AdminUserDetailInput = z.object({
  accountID,
})

export function requireAdminUserDetailAccess(context: PlatformAdminContext) {
  return requirePlatformAdminPermission(requirePlatformAdminPermission(context, "users.read"), "billing.read")
}

export async function listAdminUsers(context: PlatformAdminContext, raw: unknown) {
  const admin = requirePlatformAdminPermission(context, "users.read")
  const input = AdminUserDirectoryInput.parse(raw)
  const pattern = input.q ? `%${escapeLike(input.q.toLowerCase())}%` : undefined

  return Database.use(async (tx) => {
    const fetched = await tx
      .select({
        id: AccountTable.id,
        email: min(AuthTable.subject),
        status: AccountTable.status,
        reason: AccountTable.suspension_reason,
        timeCreated: AccountTable.timeCreated,
        timeSuspended: AccountTable.time_suspended,
      })
      .from(AccountTable)
      .leftJoin(
        AuthTable,
        and(eq(AuthTable.accountID, AccountTable.id), eq(AuthTable.provider, "email"), isNull(AuthTable.timeDeleted)),
      )
      .where(
        and(
          isNull(AccountTable.timeDeleted),
          input.status === "all" ? undefined : eq(AccountTable.status, input.status),
          input.cursor ? lt(AccountTable.id, input.cursor) : undefined,
          pattern
            ? sql<boolean>`(
                lower(${AccountTable.id}) like ${pattern} escape '\'
                or lower(coalesce(${AuthTable.subject}, '')) like ${pattern} escape '\'
              )`
            : undefined,
        ),
      )
      .groupBy(
        AccountTable.id,
        AccountTable.status,
        AccountTable.suspension_reason,
        AccountTable.timeCreated,
        AccountTable.time_suspended,
      )
      .orderBy(desc(AccountTable.id))
      .limit(input.limit + 1)

    const accounts = fetched.slice(0, input.limit)
    const ids = accounts.map((account) => account.id)
    const usage =
      ids.length > 0
        ? await tx
            .select({
              accountID: UserTable.accountID,
              memberships: count(UserTable.id),
              workspaces: countDistinct(UserTable.workspaceID),
              lastSeen: max(UserTable.timeSeen),
            })
            .from(UserTable)
            .where(and(inArray(UserTable.accountID, ids), isNull(UserTable.timeDeleted)))
            .groupBy(UserTable.accountID)
        : []
    const byAccount = new Map(usage.flatMap((row) => (row.accountID ? [[row.accountID, row] as const] : [])))

    return {
      admin,
      filters: input,
      canSuspend: admin.permissions.includes("users.suspend"),
      canInspectBilling: admin.permissions.includes("billing.read"),
      accounts: accounts.map((account) => {
        const aggregate = byAccount.get(account.id)
        return {
          id: account.id,
          email: account.email,
          status: account.status,
          reason: account.reason,
          memberships: aggregate?.memberships ?? 0,
          workspaces: aggregate?.workspaces ?? 0,
          timeCreated: account.timeCreated.toISOString(),
          timeSuspended: account.timeSuspended?.toISOString() ?? null,
          lastSeen: dateISO(aggregate?.lastSeen),
        }
      }),
      nextCursor: fetched.length > input.limit ? accounts.at(-1)?.id : undefined,
    }
  })
}

export async function getAdminUserDetail(context: PlatformAdminContext, raw: unknown, now = new Date()) {
  const admin = requireAdminUserDetailAccess(context)
  const input = AdminUserDetailInput.parse(raw)
  const usageStart = new Date(now.getTime() - 30 * day)
  const limits = await Subscription.getLimits()

  return Database.use(async (tx) => {
    const account = await tx
      .select({
        id: AccountTable.id,
        status: AccountTable.status,
        reason: AccountTable.suspension_reason,
        timeCreated: AccountTable.timeCreated,
        timeSuspended: AccountTable.time_suspended,
      })
      .from(AccountTable)
      .where(and(eq(AccountTable.id, input.accountID), isNull(AccountTable.timeDeleted)))
      .limit(1)
      .then((rows) => rows[0])

    if (!account) return { admin, account: null, generatedAt: now.toISOString() }

    const identities = await tx
      .select({
        provider: AuthTable.provider,
        subject: AuthTable.subject,
        timeCreated: AuthTable.timeCreated,
        timeUpdated: AuthTable.timeUpdated,
      })
      .from(AuthTable)
      .where(and(eq(AuthTable.accountID, input.accountID), isNull(AuthTable.timeDeleted)))
      .orderBy(AuthTable.provider, AuthTable.subject)
      .limit(20)

    const memberships = await tx
      .select({
        userID: UserTable.id,
        userName: UserTable.name,
        userEmail: UserTable.email,
        role: UserTable.role,
        timeJoined: UserTable.timeCreated,
        timeSeen: UserTable.timeSeen,
        workspaceID: WorkspaceTable.id,
        workspaceName: WorkspaceTable.name,
        workspaceSlug: WorkspaceTable.slug,
        subscriptionID: PlanSubscriptionTable.id,
        invoiceID: PlanSubscriptionTable.invoiceID,
        plan: PlanSubscriptionTable.plan,
        subscriptionStatus: PlanSubscriptionTable.status,
        timePeriodStart: PlanSubscriptionTable.timePeriodStart,
        timePeriodEnd: PlanSubscriptionTable.timePeriodEnd,
        timeCancelled: PlanSubscriptionTable.timeCancelled,
        timeRefunded: PlanSubscriptionTable.timeRefunded,
        weeklyCost: SubscriptionTable.fixedUsage,
        weeklyCostUpdated: SubscriptionTable.timeFixedUpdated,
        weeklyTokens: SubscriptionTable.weeklyTokens,
        weeklyTokensUpdated: SubscriptionTable.timeWeeklyTokensUpdated,
        weeklyRequests: SubscriptionTable.weeklyRequests,
        weeklyRequestsUpdated: SubscriptionTable.timeWeeklyRequestsUpdated,
        monthlyCost: SubscriptionTable.monthlyCost,
        monthlyCostUpdated: SubscriptionTable.timeMonthlyCostUpdated,
        monthlyTokens: SubscriptionTable.monthlyTokens,
        monthlyTokensUpdated: SubscriptionTable.timeMonthlyTokensUpdated,
        monthlyRequests: SubscriptionTable.monthlyRequests,
        monthlyRequestsUpdated: SubscriptionTable.timeMonthlyRequestsUpdated,
        rollingCost: SubscriptionTable.rollingUsage,
        rollingCostUpdated: SubscriptionTable.timeRollingUpdated,
      })
      .from(UserTable)
      .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, UserTable.workspaceID))
      .leftJoin(
        PlanSubscriptionTable,
        and(
          eq(PlanSubscriptionTable.workspaceID, UserTable.workspaceID),
          eq(PlanSubscriptionTable.status, "active"),
          lte(PlanSubscriptionTable.timePeriodStart, now),
          gt(PlanSubscriptionTable.timePeriodEnd, now),
          isNull(PlanSubscriptionTable.timeDeleted),
        ),
      )
      .leftJoin(
        SubscriptionTable,
        and(
          eq(SubscriptionTable.workspaceID, UserTable.workspaceID),
          eq(SubscriptionTable.userID, UserTable.id),
          isNull(SubscriptionTable.timeDeleted),
        ),
      )
      .where(and(eq(UserTable.accountID, input.accountID), isNull(UserTable.timeDeleted), isNull(WorkspaceTable.timeDeleted)))
      .orderBy(WorkspaceTable.name, WorkspaceTable.id)

    const workspaceIDs = memberships.map((membership) => membership.workspaceID)
    const userIDs = memberships.map((membership) => membership.userID)

    const usageAggregate =
      userIDs.length === 0
        ? undefined
        : await tx
            .select({
              requests: count(),
              inputTokens: sum(UsageTable.inputTokens),
              outputTokens: sum(UsageTable.outputTokens),
              reasoningTokens: sum(UsageTable.reasoningTokens),
              cacheReadTokens: sum(UsageTable.cacheReadTokens),
              cacheWrite5mTokens: sum(UsageTable.cacheWrite5mTokens),
              cacheWrite1hTokens: sum(UsageTable.cacheWrite1hTokens),
              cost: sum(UsageTable.cost),
            })
            .from(UsageTable)
            .where(
              and(
                inArray(UsageTable.workspaceID, workspaceIDs),
                inArray(UsageTable.userID, userIDs),
                gte(UsageTable.timeCreated, usageStart),
                lt(UsageTable.timeCreated, now),
                isNull(UsageTable.timeDeleted),
              ),
            )
            .then((rows) => rows[0])

    const usageModels =
      userIDs.length === 0
        ? []
        : await tx
            .select({
              provider: UsageTable.provider,
              model: UsageTable.model,
              requests: count(),
              inputTokens: sum(UsageTable.inputTokens),
              outputTokens: sum(UsageTable.outputTokens),
              reasoningTokens: sum(UsageTable.reasoningTokens),
              cacheReadTokens: sum(UsageTable.cacheReadTokens),
              cacheWrite5mTokens: sum(UsageTable.cacheWrite5mTokens),
              cacheWrite1hTokens: sum(UsageTable.cacheWrite1hTokens),
              cost: sum(UsageTable.cost),
            })
            .from(UsageTable)
            .where(
              and(
                inArray(UsageTable.workspaceID, workspaceIDs),
                inArray(UsageTable.userID, userIDs),
                gte(UsageTable.timeCreated, usageStart),
                lt(UsageTable.timeCreated, now),
                isNull(UsageTable.timeDeleted),
              ),
            )
            .groupBy(UsageTable.provider, UsageTable.model)
            .orderBy(desc(sum(UsageTable.cost)))
            .limit(10)

    const financeEvidence: FinanceMarginEvidence =
      userIDs.length === 0
        ? emptyFinanceMarginEvidence()
        : await getFinanceMarginEvidenceWithDb(tx, {
            start: usageStart,
            end: now,
            userIDs,
            accountID: input.accountID,
          })

    const paymentExpected = and(
      inArray(PaymentInvoiceTable.status, ["paid", "refunded"]),
      gte(PaymentInvoiceTable.time_verified, usageStart),
      lt(PaymentInvoiceTable.time_verified, now),
    )
    const refundExpected = and(
      eq(PaymentInvoiceTable.status, "refunded"),
      gte(PaymentInvoiceTable.time_refunded, usageStart),
      lt(PaymentInvoiceTable.time_refunded, now),
    )

    const invoiceSummary =
      await tx
        .select({
          paidAmount: sql<number>`coalesce(sum(case when ${paymentExpected} then ${PaymentInvoiceTable.amount} else 0 end), 0)`,
          refundedAmount: sql<number>`coalesce(sum(case when ${refundExpected} then ${PaymentInvoiceTable.amount} else 0 end), 0)`,
          paidInvoices: sql<number>`coalesce(sum(case when ${paymentExpected} then 1 else 0 end), 0)`,
          refundedInvoices: sql<number>`coalesce(sum(case when ${refundExpected} then 1 else 0 end), 0)`,
        })
        .from(PaymentInvoiceTable)
        .innerJoin(
          PaymentCheckoutTable,
          and(
            eq(PaymentCheckoutTable.provider, PaymentInvoiceTable.provider),
            eq(PaymentCheckoutTable.merchant_account_id, PaymentInvoiceTable.merchant_account_id),
            eq(PaymentCheckoutTable.external_invoice_id, PaymentInvoiceTable.external_invoice_id),
          ),
        )
        .where(
          and(
            eq(PaymentCheckoutTable.account_id, input.accountID),
            isNull(PaymentInvoiceTable.timeDeleted),
            isNull(PaymentCheckoutTable.timeDeleted),
            or(paymentExpected, refundExpected),
          ),
        )
        .then((rows) => rows[0])

    const recentInvoices =
      workspaceIDs.length === 0
        ? []
        : await tx
            .select({
              id: PaymentInvoiceTable.id,
              workspaceID: PaymentInvoiceTable.workspace_id,
              workspaceName: WorkspaceTable.name,
              provider: PaymentInvoiceTable.provider,
              purpose: PaymentInvoiceTable.purpose,
              plan: PaymentInvoiceTable.plan,
              amount: PaymentInvoiceTable.amount,
              currency: PaymentInvoiceTable.currency,
              status: PaymentInvoiceTable.status,
              timeCreated: PaymentInvoiceTable.timeCreated,
              timeVerified: PaymentInvoiceTable.time_verified,
              timeRefunded: PaymentInvoiceTable.time_refunded,
            })
            .from(PaymentInvoiceTable)
            .innerJoin(
              PaymentCheckoutTable,
              and(
                eq(PaymentCheckoutTable.provider, PaymentInvoiceTable.provider),
                eq(PaymentCheckoutTable.merchant_account_id, PaymentInvoiceTable.merchant_account_id),
                eq(PaymentCheckoutTable.external_invoice_id, PaymentInvoiceTable.external_invoice_id),
              ),
            )
            .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, PaymentInvoiceTable.workspace_id))
            .where(
              and(
                eq(PaymentCheckoutTable.account_id, input.accountID),
                isNull(PaymentInvoiceTable.timeDeleted),
                isNull(PaymentCheckoutTable.timeDeleted),
              ),
            )
            .orderBy(desc(PaymentInvoiceTable.timeCreated), desc(PaymentInvoiceTable.id))
            .limit(10)

    const paidAmount = aggregateInteger(invoiceSummary?.paidAmount)
    const refundedAmount = aggregateInteger(invoiceSummary?.refundedAmount)
    const netRevenueMNT = subtractSafeIntegers(paidAmount, refundedAmount)
    const margin = calculateFinanceGrossMargin({ netRevenueMNT, paymentProvider: "all", evidence: financeEvidence })
    const modelCostSummary = {
      ...financeEvidence.model,
      totalMNTMicros: financeEvidence.model.costMNTMicros,
    }

    return {
      admin,
      generatedAt: now.toISOString(),
      account: {
        id: account.id,
        status: account.status,
        reason: account.reason,
        timeCreated: account.timeCreated.toISOString(),
        timeSuspended: dateISO(account.timeSuspended),
        identities: identities.map((identity) => ({
          provider: identity.provider,
          subject: identity.subject,
          timeCreated: identity.timeCreated.toISOString(),
          timeUpdated: identity.timeUpdated.toISOString(),
        })),
        totals: memberships.reduce(
          (acc, membership) => {
            acc.workspaces += 1
            if (!membership.plan) acc.freeWorkspaces += 1
            if (membership.plan) acc.plans[membership.plan] += 1
            return acc
          },
          { workspaces: 0, freeWorkspaces: 0, plans: { basic: 0, pro: 0, max: 0 } },
        ),
        workspaces: memberships.map((membership) => ({
          workspaceID: membership.workspaceID,
          workspaceName: membership.workspaceName,
          workspaceSlug: membership.workspaceSlug,
          userID: membership.userID,
          userName: membership.userName,
          userEmail: membership.userEmail,
          role: membership.role,
          timeJoined: membership.timeJoined.toISOString(),
          timeSeen: dateISO(membership.timeSeen),
          currentPlan: membership.plan ?? null,
          subscription:
            membership.subscriptionID && membership.invoiceID && membership.plan && membership.subscriptionStatus
              ? {
                  id: membership.subscriptionID,
                  invoiceID: membership.invoiceID,
                  plan: membership.plan,
                  status: membership.subscriptionStatus,
                  timePeriodStart: dateISO(membership.timePeriodStart),
                  timePeriodEnd: dateISO(membership.timePeriodEnd),
                  timeCancelled: dateISO(membership.timeCancelled),
                  timeRefunded: dateISO(membership.timeRefunded),
                }
              : null,
          limits:
            membership.plan && membership.subscriptionID
              ? {
                  weeklyCostLimit: costLimit(limits.plans[membership.plan].weeklyCostLimit),
                  weeklyTokenLimit: limits.plans[membership.plan].weeklyTokenLimit,
                  weeklyRequestLimit: limits.plans[membership.plan].weeklyRequestLimit,
                  monthlyCostLimit: costLimit(limits.plans[membership.plan].monthlyCostLimit),
                  monthlyTokenLimit: limits.plans[membership.plan].monthlyTokenLimit,
                  monthlyRequestLimit: limits.plans[membership.plan].monthlyRequestLimit,
                  rollingCostLimit: costLimit(limits.plans[membership.plan].rollingCostLimit),
                  rollingWindowHours: limits.plans[membership.plan].rollingWindow,
                }
              : {
                  promoTokens: limits.free.promoTokens,
                  dailyRequests: limits.free.dailyRequests,
                  dailyRequestsFallback: limits.free.dailyRequestsFallback,
                },
          usageSnapshot: {
            weeklyCost: snapshot(membership.weeklyCost, membership.weeklyCostUpdated),
            weeklyTokens: snapshot(membership.weeklyTokens, membership.weeklyTokensUpdated),
            weeklyRequests: snapshot(membership.weeklyRequests, membership.weeklyRequestsUpdated),
            monthlyCost: snapshot(membership.monthlyCost, membership.monthlyCostUpdated),
            monthlyTokens: snapshot(membership.monthlyTokens, membership.monthlyTokensUpdated),
            monthlyRequests: snapshot(membership.monthlyRequests, membership.monthlyRequestsUpdated),
            rollingCost: snapshot(membership.rollingCost, membership.rollingCostUpdated),
            lastUpdated: latestDateISO([
              membership.weeklyCostUpdated,
              membership.weeklyTokensUpdated,
              membership.weeklyRequestsUpdated,
              membership.monthlyCostUpdated,
              membership.monthlyTokensUpdated,
              membership.monthlyRequestsUpdated,
              membership.rollingCostUpdated,
            ]),
          },
        })),
        usage: {
          periodStart: usageStart.toISOString(),
          periodEnd: now.toISOString(),
          aggregate: normalizeUsage(usageAggregate),
          models: usageModels.map((row) => ({ provider: row.provider, model: row.model, ...normalizeUsage(row) })),
        },
        modelCost: modelCostSummary,
        paymentSummary: {
          invoices: aggregateInteger(invoiceSummary?.paidInvoices),
          paidInvoices: aggregateInteger(invoiceSummary?.paidInvoices),
          refundedInvoices: aggregateInteger(invoiceSummary?.refundedInvoices),
          grossMNT: paidAmount,
          refundedMNT: refundedAmount,
          netMNT: netRevenueMNT,
          feeMNTMicros: financeEvidence.payments.feeMNTMicros,
          taxMNTMicros: financeEvidence.payments.taxMNTMicros,
          recognizedRevenueMNTMicros: margin.recognizedRevenueMNTMicros,
          grossMarginMNTMicros: margin.valueMNTMicros,
          marginReasons: margin.reasons,
          invoicesRecent: recentInvoices.map((invoice) => ({
            id: invoice.id,
            workspaceID: invoice.workspaceID,
            workspaceName: invoice.workspaceName,
            provider: invoice.provider,
            purpose: invoice.purpose,
            plan: invoice.plan,
            amount: invoice.amount,
            currency: invoice.currency,
            status: invoice.status,
            timeCreated: invoice.timeCreated.toISOString(),
            timeVerified: dateISO(invoice.timeVerified),
            timeRefunded: dateISO(invoice.timeRefunded),
          })),
        },
      },
    }
  })
}

export async function changeAdminAccountStatus(context: PlatformAdminContext, request: Request, raw: unknown) {
  const targetID =
    typeof raw === "object" && raw !== null && "accountID" in raw && typeof raw.accountID === "string"
      ? raw.accountID.slice(0, 30)
      : undefined
  const action =
    typeof raw === "object" && raw !== null && "operation" in raw && raw.operation === "reactivate"
      ? "account.reactivate"
      : "account.suspend"

  try {
    requireSameOriginAdminMutation(request)
    const admin = requirePlatformAdminPermission(context, "users.suspend")
    const input = AdminAccountStatusInput.parse(raw)
    return await Database.transaction(async (tx) => {
      const target = await tx
        .select({
          id: AccountTable.id,
          email: AuthTable.subject,
        })
        .from(AccountTable)
        .leftJoin(
          AuthTable,
          and(eq(AuthTable.accountID, AccountTable.id), eq(AuthTable.provider, "email"), isNull(AuthTable.timeDeleted)),
        )
        .where(and(eq(AccountTable.id, input.accountID), isNull(AccountTable.timeDeleted)))
      if (target.length === 0) throw new AdminAccountMutationError("not_found")
      if (
        input.operation === "suspend" &&
        target.some((identity) => identity.email?.trim().toLowerCase() === admin.email)
      ) {
        throw new AdminAccountMutationError("self_suspend")
      }

      const transition = await AccountAccess.transition(tx, {
        accountID: input.accountID,
        adminID: admin.id,
        status: input.operation === "suspend" ? "suspended" : "active",
        reason: input.reason,
      })
      await writeAdminAuditWithDb(tx, {
        adminID: admin.id,
        actorEmail: admin.email,
        action,
        outcome: "success",
        request,
        targetType: "account",
        targetID: input.accountID,
        metadata: {
          operation: input.operation,
          reason: input.reason,
          changed: transition.changed,
          before: transition.before,
          after: transition.after,
          auth_version: transition.authVersion,
          revoked_api_keys: transition.revokedApiKeys,
        },
      })
      return {
        ok: true as const,
        accountID: input.accountID,
        operation: input.operation,
        changed: transition.changed,
        message: transitionMessage(input.operation, transition.changed),
      }
    })
  } catch (error) {
    const failure = mutationFailure(error)
    await writeAdminAudit({
      adminID: context.id,
      actorEmail: context.email,
      action,
      outcome: failure.outcome,
      request,
      targetType: "account",
      targetID,
      metadata: {
        reason: failure.code,
      },
    })
    return {
      ok: false as const,
      accountID: targetID,
      message: failure.message,
    }
  }
}

function normalizeUsage(
  row:
    | {
        requests?: number | null
        inputTokens?: unknown
        outputTokens?: unknown
        reasoningTokens?: unknown
        cacheReadTokens?: unknown
        cacheWrite5mTokens?: unknown
        cacheWrite1hTokens?: unknown
        cost?: unknown
      }
    | undefined,
) {
  const inputTokens = aggregateInteger(row?.inputTokens)
  const outputTokens = aggregateInteger(row?.outputTokens)
  const reasoningTokens = aggregateInteger(row?.reasoningTokens)
  const cacheReadTokens = aggregateInteger(row?.cacheReadTokens)
  const cacheWriteTokens = aggregateInteger(row?.cacheWrite5mTokens) + aggregateInteger(row?.cacheWrite1hTokens)
  return {
    requests: aggregateInteger(row?.requests),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokens: inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens,
    cost: aggregateInteger(row?.cost),
  }
}

function snapshot(value: number | null, updated: Date | null) {
  return {
    used: aggregateInteger(value),
    timeUpdated: dateISO(updated),
  }
}

function latestDateISO(values: Array<Date | null>) {
  const dates = values.filter((value): value is Date => value instanceof Date)
  if (dates.length === 0) return null
  return dates.sort((left, right) => right.getTime() - left.getTime())[0].toISOString()
}

function aggregateInteger(value: unknown) {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Хэрэглэгчийн нийлбэр утга хүчинтэй бүхэл тоо биш байна.")
  }
  return parsed
}

function subtractSafeIntegers(left: number, right: number) {
  const value = BigInt(left) - BigInt(right)
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Хэрэглэгчийн орлогын нийлбэр аюулгүй бүхэл тооны хязгаараас хэтэрлээ.")
  }
  return Number(value)
}

function emptyFinanceMarginEvidence(): FinanceMarginEvidence {
  return {
    model: {
      expectedUsage: 0,
      coveredUsage: 0,
      missingUsage: 0,
      valuedEntries: 0,
      unvaluedEntries: 0,
      debitMNTMicros: 0,
      creditMNTMicros: 0,
      costMNTMicros: 0,
      complete: true,
    },
    payments: {
      expectedEvents: 0,
      coveredEvents: 0,
      missingEvents: 0,
      ambiguousEvents: 0,
      feeMNTMicros: 0,
      taxMNTMicros: 0,
      revenueAdjustmentMNTMicros: 0,
      costMNTMicros: 0,
      complete: true,
    },
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function dateISO(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return null
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function costLimit(value: number) {
  return value * 100 * 1_000_000
}

function transitionMessage(operation: "suspend" | "reactivate", changed: boolean) {
  if (!changed) {
    return operation === "suspend" ? "Аккаунт өмнө нь түдгэлзсэн байна." : "Аккаунт аль хэдийн идэвхтэй байна."
  }
  return operation === "suspend"
    ? "Аккаунтыг түдгэлзүүлж, өмнөх нэвтрэх сесс болон API түлхүүрүүдийг хүчингүй болголоо."
    : "Аккаунтыг дахин идэвхжүүллээ. Хэрэглэгч шинээр нэвтрэх шаардлагатай."
}

function mutationFailure(error: unknown) {
  if (error instanceof AdminMutationRequestError) {
    return {
      outcome: "denied" as const,
      code: `request_${error.code}`,
      message: "Аюулгүй байдлын хүсэлтийн шалгалт амжилтгүй боллоо.",
    }
  }
  if (error instanceof AdminAuthorizationError) {
    return {
      outcome: "denied" as const,
      code: error.code,
      message: error.message,
    }
  }
  if (error instanceof z.ZodError) {
    return {
      outcome: "denied" as const,
      code: "invalid_input",
      message: "Аккаунтын ID, үйлдэл эсвэл шалтгаан буруу байна.",
    }
  }
  if (error instanceof AdminAccountMutationError) {
    return {
      outcome: "denied" as const,
      code: error.code,
      message:
        error.code === "self_suspend" ? "Өөрийн аккаунтыг түдгэлзүүлэх боломжгүй." : "Удирдах аккаунт олдсонгүй.",
    }
  }
  if (error instanceof AccountAccess.TransitionError) {
    return {
      outcome: error.code === "conflict" ? ("failure" as const) : ("denied" as const),
      code: error.code,
      message:
        error.code === "conflict"
          ? "Аккаунтын төлөв зэрэг өөрчлөгдсөн. Дахин оролдоно уу."
          : "Удирдах аккаунт олдсонгүй.",
    }
  }
  return {
    outcome: "failure" as const,
    code: "internal_error",
    message: "Аккаунтын төлөв өөрчлөх үед алдаа гарлаа.",
  }
}

class AdminAccountMutationError extends Error {
  constructor(readonly code: "not_found" | "self_suspend") {
    super(code)
    this.name = "AdminAccountMutationError"
  }
}
