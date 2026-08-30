import { z } from "zod"
import {
  and,
  count,
  countDistinct,
  Database,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  max,
  sql,
  sum,
} from "@mongolgpt/console-core/drizzle/index.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import {
  PaymentInvoiceTable,
  PlanSubscriptionTable,
  SubscriptionTable,
  UsageTable,
} from "@mongolgpt/console-core/schema/billing.sql.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import {
  readPaidPlanQuota,
  type PaidPlanQuotaLimits,
  type ReadPlanQuota,
} from "@mongolgpt/console-core/paid-plan-quota.js"
import { planQuotaCounterKeys, planQuotaScope } from "@mongolgpt/console-core/quota.js"
import { getMonthlyBounds, getWeekBounds } from "@mongolgpt/console-core/util/date.js"
import type { PlatformAdminContext } from "./admin-context"
import { requirePlatformAdminPermission } from "./admin-auth"

const day = 86_400_000
const workspaceID = z.string().regex(/^wrk_[0-9A-HJKMNP-TV-Z]{26}$/)

export const AdminWorkspaceInvestigationInput = z.object({
  q: z.string().trim().max(100).default(""),
  cursor: workspaceID.optional(),
  workspace: workspaceID.optional(),
  limit: z.union([z.literal(25), z.literal(50)]).default(25),
})

export type AdminWorkspaceDependencies = {
  getPlanLimits?: (plan: "basic" | "pro" | "max") => PaidPlanQuotaLimits | Promise<PaidPlanQuotaLimits>
  readPlanQuota?: ReadPlanQuota
}

export function requireAdminWorkspaceInvestigationAccess(context: PlatformAdminContext) {
  return requirePlatformAdminPermission(requirePlatformAdminPermission(context, "users.read"), "billing.read")
}

export async function listAdminWorkspaces(
  context: PlatformAdminContext,
  raw: unknown,
  now = new Date(),
  dependencies: AdminWorkspaceDependencies = {},
) {
  return Database.use((tx) => listAdminWorkspacesWithDb(tx, context, raw, now, dependencies))
}

export async function listAdminWorkspacesWithDb(
  tx: Database.TxOrDb,
  context: PlatformAdminContext,
  raw: unknown,
  now = new Date(),
  dependencies: AdminWorkspaceDependencies = {},
) {
  const admin = requireAdminWorkspaceInvestigationAccess(context)
  const input = AdminWorkspaceInvestigationInput.parse(raw)
  const pattern = input.q ? `%${escapeLike(input.q.toLowerCase())}%` : undefined
  const usageStart = new Date(now.getTime() - 30 * day)
  const getPlanLimits =
    dependencies.getPlanLimits ??
    (async (plan: "basic" | "pro" | "max") => {
      const { Subscription } = await import("@mongolgpt/console-core/subscription.js")
      return (await Subscription.getLimits()).plans[plan]
    })
  const readPlanQuota =
    dependencies.readPlanQuota ??
    (async (request: Parameters<ReadPlanQuota>[0]) => {
      const { readAdminPlanQuota } = await import("./admin-quota.server")
      return readAdminPlanQuota(request)
    })

  const fetched = await tx
    .select({
      id: WorkspaceTable.id,
      name: WorkspaceTable.name,
      slug: WorkspaceTable.slug,
      timeCreated: WorkspaceTable.timeCreated,
      members: count(UserTable.id),
      accounts: countDistinct(UserTable.accountID),
      lastSeen: max(UserTable.timeSeen),
    })
    .from(WorkspaceTable)
    .leftJoin(UserTable, and(eq(UserTable.workspaceID, WorkspaceTable.id), isNull(UserTable.timeDeleted)))
    .where(
      and(
        isNull(WorkspaceTable.timeDeleted),
        input.cursor ? lt(WorkspaceTable.id, input.cursor) : undefined,
        pattern
          ? sql<boolean>`(
                lower(${WorkspaceTable.id}) like ${pattern} escape '\'
                or lower(${WorkspaceTable.name}) like ${pattern} escape '\'
                or lower(coalesce(${WorkspaceTable.slug}, '')) like ${pattern} escape '\'
              )`
          : undefined,
      ),
    )
    .groupBy(WorkspaceTable.id, WorkspaceTable.name, WorkspaceTable.slug, WorkspaceTable.timeCreated)
    .orderBy(desc(WorkspaceTable.id))
    .limit(input.limit + 1)

  const workspaces = fetched.slice(0, input.limit)
  const selectedWorkspace = input.workspace
    ? await getAdminWorkspaceDetail(tx, input.workspace, {
        usageStart,
        usageEnd: now,
        getPlanLimits,
        readPlanQuota,
      })
    : null

  return {
    admin,
    filters: input,
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      timeCreated: workspace.timeCreated.toISOString(),
      members: workspace.members,
      accounts: workspace.accounts,
      lastSeen: dateISO(workspace.lastSeen),
    })),
    selectedWorkspace,
    nextCursor: fetched.length > input.limit ? workspaces.at(-1)?.id : undefined,
    generatedAt: now.toISOString(),
  }
}

async function getAdminWorkspaceDetail(
  tx: Database.TxOrDb,
  targetWorkspaceID: string,
  usagePeriod: {
    usageStart: Date
    usageEnd: Date
    getPlanLimits: NonNullable<AdminWorkspaceDependencies["getPlanLimits"]>
    readPlanQuota: ReadPlanQuota
  },
) {
  const workspace = await tx
    .select({
      id: WorkspaceTable.id,
      name: WorkspaceTable.name,
      slug: WorkspaceTable.slug,
      timeCreated: WorkspaceTable.timeCreated,
    })
    .from(WorkspaceTable)
    .where(and(eq(WorkspaceTable.id, targetWorkspaceID), isNull(WorkspaceTable.timeDeleted)))
    .limit(1)
    .then((rows) => rows[0])

  if (!workspace) return null

  const [members, totals, currentSubscription, usageAggregate, usageByModel, recentInvoices] = await Promise.all([
    tx
      .select({
        id: UserTable.id,
        name: UserTable.name,
        email: UserTable.email,
        role: UserTable.role,
        accountID: UserTable.accountID,
        accountStatus: AccountTable.status,
        timeSeen: UserTable.timeSeen,
        fixedUsage: SubscriptionTable.fixedUsage,
        fixedUpdated: SubscriptionTable.timeFixedUpdated,
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
        rollingUsage: SubscriptionTable.rollingUsage,
        rollingUpdated: SubscriptionTable.timeRollingUpdated,
      })
      .from(UserTable)
      .leftJoin(AccountTable, and(eq(AccountTable.id, UserTable.accountID), isNull(AccountTable.timeDeleted)))
      .leftJoin(
        SubscriptionTable,
        and(
          eq(SubscriptionTable.workspaceID, workspace.id),
          eq(SubscriptionTable.userID, UserTable.id),
          isNull(SubscriptionTable.timeDeleted),
        ),
      )
      .where(and(eq(UserTable.workspaceID, workspace.id), isNull(UserTable.timeDeleted)))
      .orderBy(sql`case when ${UserTable.role} = 'admin' then 0 else 1 end`, UserTable.name, UserTable.id)
      .limit(100),
    tx
      .select({
        members: count(UserTable.id),
        accounts: countDistinct(UserTable.accountID),
        lastSeen: max(UserTable.timeSeen),
      })
      .from(UserTable)
      .where(and(eq(UserTable.workspaceID, workspace.id), isNull(UserTable.timeDeleted))),
    tx
      .select({
        id: PlanSubscriptionTable.id,
        invoiceID: PlanSubscriptionTable.invoiceID,
        plan: PlanSubscriptionTable.plan,
        status: PlanSubscriptionTable.status,
        timePeriodStart: PlanSubscriptionTable.timePeriodStart,
        timePeriodEnd: PlanSubscriptionTable.timePeriodEnd,
        timeCancelled: PlanSubscriptionTable.timeCancelled,
        timeRefunded: PlanSubscriptionTable.timeRefunded,
        provider: PaymentInvoiceTable.provider,
        amount: PaymentInvoiceTable.amount,
        currency: PaymentInvoiceTable.currency,
        invoiceStatus: PaymentInvoiceTable.status,
        timeCreated: PaymentInvoiceTable.timeCreated,
        timeVerified: PaymentInvoiceTable.time_verified,
      })
      .from(PlanSubscriptionTable)
      .leftJoin(
        PaymentInvoiceTable,
        and(eq(PaymentInvoiceTable.id, PlanSubscriptionTable.invoiceID), isNull(PaymentInvoiceTable.timeDeleted)),
      )
      .where(and(eq(PlanSubscriptionTable.workspaceID, workspace.id), isNull(PlanSubscriptionTable.timeDeleted)))
      .orderBy(
        sql`case when ${and(
          eq(PlanSubscriptionTable.status, "active"),
          lte(PlanSubscriptionTable.timePeriodStart, usagePeriod.usageEnd),
          gt(PlanSubscriptionTable.timePeriodEnd, usagePeriod.usageEnd),
        )} then 0 else 1 end`,
        desc(PlanSubscriptionTable.timePeriodEnd),
        desc(PlanSubscriptionTable.id),
      )
      .limit(1)
      .then((rows) => rows[0]),
    tx
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
          eq(UsageTable.workspaceID, workspace.id),
          gte(UsageTable.timeCreated, usagePeriod.usageStart),
          lt(UsageTable.timeCreated, usagePeriod.usageEnd),
          isNull(UsageTable.timeDeleted),
        ),
      )
      .then((rows) => rows[0]),
    tx
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
          eq(UsageTable.workspaceID, workspace.id),
          gte(UsageTable.timeCreated, usagePeriod.usageStart),
          lt(UsageTable.timeCreated, usagePeriod.usageEnd),
          isNull(UsageTable.timeDeleted),
        ),
      )
      .groupBy(UsageTable.provider, UsageTable.model)
      .orderBy(desc(sum(UsageTable.cost)))
      .limit(10),
    tx
      .select({
        id: PaymentInvoiceTable.id,
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
      .where(and(eq(PaymentInvoiceTable.workspace_id, workspace.id), isNull(PaymentInvoiceTable.timeDeleted)))
      .orderBy(desc(PaymentInvoiceTable.timeCreated), desc(PaymentInvoiceTable.id))
      .limit(10),
  ])

  const aggregate = totals[0]
  const activeSubscription =
    currentSubscription?.status === "active" &&
    currentSubscription.timePeriodStart <= usagePeriod.usageEnd &&
    currentSubscription.timePeriodEnd > usagePeriod.usageEnd
      ? currentSubscription
      : null
  const memberQuota = activeSubscription
    ? await getAdminWorkspaceMemberQuota(
        workspace.id,
        members,
        activeSubscription,
        await usagePeriod.getPlanLimits(activeSubscription.plan),
        usagePeriod,
      )
    : []
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    timeCreated: workspace.timeCreated.toISOString(),
    members: {
      total: aggregate?.members ?? 0,
      accounts: aggregate?.accounts ?? 0,
      lastSeen: dateISO(aggregate?.lastSeen),
      entries: members.map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
        accountID: member.accountID,
        accountStatus: member.accountStatus ?? null,
        timeSeen: dateISO(member.timeSeen),
      })),
    },
    subscription: currentSubscription
      ? {
          id: currentSubscription.id,
          invoiceID: currentSubscription.invoiceID,
          plan: currentSubscription.plan,
          status: currentSubscription.status,
          provider: currentSubscription.provider ?? null,
          amount: currentSubscription.amount ?? null,
          currency: currentSubscription.currency ?? null,
          invoiceStatus: currentSubscription.invoiceStatus ?? null,
          timeCreated: currentSubscription.timeCreated?.toISOString() ?? null,
          timeVerified: currentSubscription.timeVerified?.toISOString() ?? null,
          timePeriodStart: currentSubscription.timePeriodStart.toISOString(),
          timePeriodEnd: currentSubscription.timePeriodEnd.toISOString(),
          timeCancelled: currentSubscription.timeCancelled?.toISOString() ?? null,
          timeRefunded: currentSubscription.timeRefunded?.toISOString() ?? null,
        }
      : null,
    quota: activeSubscription
      ? {
          mode: "paid-plan" as const,
          plan: activeSubscription.plan,
          invoiceID: activeSubscription.invoiceID,
          members: memberQuota,
        }
      : {
          mode: "model-scoped" as const,
          reason: "no-active-paid-plan" as const,
          members: [],
        },
    usage: {
      periodStart: usagePeriod.usageStart.toISOString(),
      periodEnd: usagePeriod.usageEnd.toISOString(),
      aggregate: normalizeUsage(usageAggregate),
      models: usageByModel.map((row) => ({
        provider: row.provider,
        model: row.model,
        ...normalizeUsage(row),
      })),
    },
    invoices: recentInvoices.map((invoice) => ({
      id: invoice.id,
      provider: invoice.provider,
      purpose: invoice.purpose,
      plan: invoice.plan,
      amount: invoice.amount,
      currency: invoice.currency,
      status: invoice.status,
      timeCreated: invoice.timeCreated.toISOString(),
      timeVerified: invoice.timeVerified?.toISOString() ?? null,
      timeRefunded: invoice.timeRefunded?.toISOString() ?? null,
    })),
  }
}

async function getAdminWorkspaceMemberQuota(
  workspaceID: string,
  members: Array<{
    id: string
    name: string
    email: string | null
    role: "admin" | "member"
    accountID: string | null
    accountStatus: "active" | "suspended" | null
    fixedUsage: number | null
    fixedUpdated: Date | null
    weeklyTokens: number | null
    weeklyTokensUpdated: Date | null
    weeklyRequests: number | null
    weeklyRequestsUpdated: Date | null
    monthlyCost: number | null
    monthlyCostUpdated: Date | null
    monthlyTokens: number | null
    monthlyTokensUpdated: Date | null
    monthlyRequests: number | null
    monthlyRequestsUpdated: Date | null
    rollingUsage: number | null
    rollingUpdated: Date | null
  }>,
  subscription: {
    invoiceID: string
    timePeriodStart: Date
  },
  limits: PaidPlanQuotaLimits,
  dependencies: {
    usageEnd: Date
    readPlanQuota: ReadPlanQuota
  },
) {
  const week = getWeekBounds(dependencies.usageEnd)
  const month = getMonthlyBounds(dependencies.usageEnd, subscription.timePeriodStart)
  const connected = members.filter((member): member is typeof member & { accountID: string } =>
    Boolean(member.accountID),
  )
  const scope = planQuotaScope(workspaceID, subscription.invoiceID)
  const live = await Promise.all(
    chunk(
      connected.flatMap((member) => Object.values(planQuotaCounterKeys(member.id))),
      64,
    ).map((keys) => dependencies.readPlanQuota({ scope, keys })),
  )
    .then((records) => Object.assign({}, ...records) as Record<string, number>)
    .catch(() => null)
  const read: ReadPlanQuota = async (input) => {
    if (!live || input.scope !== scope) throw new Error("Админ квотын багц уншилт таарахгүй байна.")
    return Object.fromEntries(input.keys.filter((key) => key in live).map((key) => [key, live[key]!]))
  }
  return Promise.all(
    connected.map(async (member) => ({
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      accountID: member.accountID,
      accountStatus: member.accountStatus,
      quota: await readPaidPlanQuota(
        { ...member, id: workspaceID, userID: member.id },
        subscription.invoiceID,
        limits,
        dependencies.usageEnd.getTime(),
        week.end.getTime(),
        month.start.getTime(),
        month.end.getTime(),
        read,
      ),
    })),
  )
}

function chunk<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
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

function aggregateInteger(value: unknown) {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Ажлын орон зайн нийлбэр утга хүчинтэй бүхэл тоо биш байна.")
  }
  return parsed
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function dateISO(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return null
  return (value instanceof Date ? value : new Date(value)).toISOString()
}
