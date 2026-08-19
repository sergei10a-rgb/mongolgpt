import { AccountOverviewSchema, PlanNames, type AccountOverview } from "@mongolgpt/account-contract"
import { and, Database, eq, gt, gte, isNull, lt, lte, sql } from "./drizzle"
import { PlanData } from "./plan"
import { planQuotaCounterKeys, planQuotaScope } from "./quota"
import { AccountTable } from "./schema/account.sql"
import { PlanSubscriptionTable, SubscriptionTable, UsageTable } from "./schema/billing.sql"
import { UserTable } from "./schema/user.sql"
import { WorkspaceTable } from "./schema/workspace.sql"
import { Subscription } from "./subscription"
import { getWeekBounds } from "./util/date"
import { centsToMicroCents } from "./util/price"
import { z } from "zod"

const inputSchema = z
  .object({
    accountID: z.string().trim().min(5).max(30).regex(/^acc_/),
    email: z.string().trim().email().max(320),
    currentWorkspaceID: z.string().trim().min(5).max(30).regex(/^wrk_/).optional(),
    now: z.number().int().nonnegative().optional(),
  })
  .strict()

type PlanLimits = z.output<typeof Subscription.LimitsSchema>["plans"][(typeof PlanNames)[number]]
type FreeLimits = z.output<typeof Subscription.LimitsSchema>["free"]

export type AccountOverviewDependencies = {
  getFreeLimits?: () => FreeLimits
  getPlanLimits?: (plan: (typeof PlanNames)[number]) => PlanLimits
  readPlanQuota?: (input: { scope: string; keys: readonly string[] }) => Promise<Record<string, number>>
}

export class AccountOverviewNotFoundError extends Error {
  constructor() {
    super("MongolGPT аккаунт олдсонгүй")
    this.name = "AccountOverviewNotFoundError"
  }
}

export class AccountOverviewSuspendedError extends Error {
  constructor() {
    super("MongolGPT аккаунт түр түдгэлзсэн байна")
    this.name = "AccountOverviewSuspendedError"
  }
}

export class AccountOverviewWorkspaceAccessError extends Error {
  constructor() {
    super("Энэ workspace-д хандах эрхгүй байна")
    this.name = "AccountOverviewWorkspaceAccessError"
  }
}

export function getAccountOverview(input: z.input<typeof inputSchema>, dependencies: AccountOverviewDependencies = {}) {
  return Database.use((db) => getAccountOverviewWithDb(db, input, dependencies))
}

export async function getAccountOverviewWithDb(
  db: Database.TxOrDb,
  raw: z.input<typeof inputSchema>,
  dependencies: AccountOverviewDependencies = {},
): Promise<AccountOverview> {
  const input = inputSchema.parse(raw)
  const now = input.now ?? Date.now()
  const current = new Date(now)
  const account = await db
    .select({
      id: AccountTable.id,
      status: AccountTable.status,
      createdAt: AccountTable.timeCreated,
    })
    .from(AccountTable)
    .where(and(eq(AccountTable.id, input.accountID), isNull(AccountTable.timeDeleted)))
    .limit(1)
    .then((rows) => rows[0])
  if (!account) throw new AccountOverviewNotFoundError()
  if (account.status === "suspended") throw new AccountOverviewSuspendedError()

  const memberships = await db
    .select({
      id: WorkspaceTable.id,
      name: WorkspaceTable.name,
      slug: WorkspaceTable.slug,
      userID: UserTable.id,
      role: UserTable.role,
      subscriptionID: PlanSubscriptionTable.id,
      invoiceID: PlanSubscriptionTable.invoiceID,
      plan: PlanSubscriptionTable.plan,
      periodStart: PlanSubscriptionTable.timePeriodStart,
      periodEnd: PlanSubscriptionTable.timePeriodEnd,
      fixedUsage: SubscriptionTable.fixedUsage,
      fixedUpdated: SubscriptionTable.timeFixedUpdated,
      weeklyTokens: SubscriptionTable.weeklyTokens,
      weeklyTokensUpdated: SubscriptionTable.timeWeeklyTokensUpdated,
      rollingUsage: SubscriptionTable.rollingUsage,
      rollingUpdated: SubscriptionTable.timeRollingUpdated,
    })
    .from(UserTable)
    .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, UserTable.workspaceID))
    .leftJoin(
      PlanSubscriptionTable,
      and(
        eq(PlanSubscriptionTable.workspaceID, UserTable.workspaceID),
        eq(PlanSubscriptionTable.status, "active"),
        lte(PlanSubscriptionTable.timePeriodStart, current),
        gt(PlanSubscriptionTable.timePeriodEnd, current),
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
    .where(
      and(eq(UserTable.accountID, input.accountID), isNull(UserTable.timeDeleted), isNull(WorkspaceTable.timeDeleted)),
    )
    .orderBy(WorkspaceTable.name, WorkspaceTable.id)

  if (input.currentWorkspaceID && !memberships.some((item) => item.id === input.currentWorkspaceID)) {
    throw new AccountOverviewWorkspaceAccessError()
  }
  const currentWorkspaceID = input.currentWorkspaceID ?? (memberships.length === 1 ? memberships[0].id : null)
  const freeLimits = (dependencies.getFreeLimits ?? Subscription.getFreeLimits)()
  const getPlanLimits = dependencies.getPlanLimits ?? ((plan) => PlanData.getLimits({ plan }))
  const week = getWeekBounds(current)
  const workspaces = await Promise.all(
    memberships.map(async (item) => {
      const active =
        item.subscriptionID && item.invoiceID && item.plan && item.periodStart && item.periodEnd
          ? {
              id: item.subscriptionID,
              invoiceID: item.invoiceID,
              plan: item.plan,
              status: "active" as const,
              periodStart: item.periodStart.getTime(),
              periodEnd: item.periodEnd.getTime(),
            }
          : null
      const period = active
        ? { kind: "subscription" as const, start: active.periodStart, end: active.periodEnd }
        : { kind: "week" as const, start: week.start.getTime(), end: week.end.getTime() }
      const usage = await workspaceUsage(db, item.id, period)
      if (!active) {
        return {
          id: item.id,
          name: item.name,
          slug: item.slug,
          userID: item.userID,
          role: item.role,
          subscription: null,
          limits: {
            plan: "free" as const,
            promoTokens: freeLimits.promoTokens,
            dailyRequests: freeLimits.dailyRequests,
            dailyRequestsFallback: freeLimits.dailyRequestsFallback,
          },
          quota: { status: "model-scoped" as const, reason: "free-auto-model-limits" as const },
          usage,
        }
      }

      const limits = getPlanLimits(active.plan)
      return {
        id: item.id,
        name: item.name,
        slug: item.slug,
        userID: item.userID,
        role: item.role,
        subscription: active,
        limits: {
          plan: active.plan,
          weeklyCostLimitInMicroCents: costLimit(limits.weeklyCostLimit),
          weeklyTokenLimit: limits.weeklyTokenLimit,
          rollingCostLimitInMicroCents: costLimit(limits.rollingCostLimit),
          rollingWindowHours: limits.rollingWindow,
        },
        quota: await paidQuota(item, active.invoiceID, limits, now, week.end.getTime(), dependencies.readPlanQuota),
        usage,
      }
    }),
  )

  return AccountOverviewSchema.parse({
    account: {
      id: account.id,
      email: input.email,
      status: "active",
      createdAt: account.createdAt.getTime(),
    },
    currentWorkspaceID,
    workspaces,
  })
}

async function workspaceUsage(
  db: Database.TxOrDb,
  workspaceID: string,
  period: { kind: "week" | "subscription"; start: number; end: number },
) {
  const row = await db
    .select({
      requestCount: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${UsageTable.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${UsageTable.outputTokens}), 0)`,
      reasoningTokens: sql<number>`coalesce(sum(${UsageTable.reasoningTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${UsageTable.cacheReadTokens}), 0)`,
      cacheWrite5mTokens: sql<number>`coalesce(sum(${UsageTable.cacheWrite5mTokens}), 0)`,
      cacheWrite1hTokens: sql<number>`coalesce(sum(${UsageTable.cacheWrite1hTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${UsageTable.cost}), 0)`,
    })
    .from(UsageTable)
    .where(
      and(
        eq(UsageTable.workspaceID, workspaceID),
        gte(UsageTable.timeCreated, new Date(period.start)),
        lt(UsageTable.timeCreated, new Date(period.end)),
        isNull(UsageTable.timeDeleted),
      ),
    )
    .then((rows) => rows[0])
  const cacheWriteTokens = number(row?.cacheWrite5mTokens) + number(row?.cacheWrite1hTokens)
  const totalTokens =
    number(row?.inputTokens) +
    number(row?.outputTokens) +
    number(row?.reasoningTokens) +
    number(row?.cacheReadTokens) +
    cacheWriteTokens
  return {
    scope: "workspace" as const,
    period: period.kind,
    periodStart: period.start,
    periodEnd: period.end,
    requestCount: number(row?.requestCount),
    inputTokens: number(row?.inputTokens),
    outputTokens: number(row?.outputTokens),
    reasoningTokens: number(row?.reasoningTokens),
    cacheReadTokens: number(row?.cacheReadTokens),
    cacheWriteTokens,
    totalTokens,
    costInMicroCents: number(row?.cost),
  }
}

async function paidQuota(
  item: {
    id: string
    userID: string
    fixedUsage: number | null
    fixedUpdated: Date | null
    weeklyTokens: number | null
    weeklyTokensUpdated: Date | null
    rollingUsage: number | null
    rollingUpdated: Date | null
  },
  invoiceID: string,
  limits: PlanLimits,
  now: number,
  weekEnd: number,
  read: AccountOverviewDependencies["readPlanQuota"],
) {
  if (!read) return { status: "unavailable" as const, reason: "quota-service-unavailable" as const }
  const keys = planQuotaCounterKeys(item.userID)
  const rollingWindow = limits.rollingWindow * 3_600_000
  const weekStart = weekEnd - 7 * 24 * 3_600_000
  const rollingStart = now - rollingWindow
  try {
    const live = await read({ scope: planQuotaScope(item.id, invoiceID), keys: Object.values(keys) })
    const weeklyCost = Math.max(fresh(item.fixedUsage, item.fixedUpdated, weekStart), counter(live, keys.weeklyCost))
    const weeklyTokens = Math.max(
      fresh(item.weeklyTokens, item.weeklyTokensUpdated, weekStart),
      counter(live, keys.weeklyTokens),
    )
    const rollingCost = Math.max(
      fresh(item.rollingUsage, item.rollingUpdated, rollingStart),
      counter(live, keys.rollingCost),
    )
    const rollingReset =
      item.rollingUpdated && item.rollingUpdated.getTime() >= rollingStart
        ? item.rollingUpdated.getTime() + rollingWindow
        : null
    return {
      status: "available" as const,
      weeklyCost: { used: weeklyCost, limit: costLimit(limits.weeklyCostLimit), resetAt: weekEnd },
      weeklyTokens: { used: weeklyTokens, limit: limits.weeklyTokenLimit, resetAt: weekEnd },
      rollingCost: { used: rollingCost, limit: costLimit(limits.rollingCostLimit), resetAt: rollingReset },
    }
  } catch {
    return { status: "unavailable" as const, reason: "quota-service-unavailable" as const }
  }
}

function fresh(value: number | null, updated: Date | null, threshold: number) {
  if (!updated || updated.getTime() < threshold) return 0
  return number(value)
}

function counter(values: Record<string, number>, key: string) {
  if (!(key in values)) throw new TypeError("Quota counter дутуу байна")
  return number(values[key])
}

function costLimit(value: number) {
  return centsToMicroCents(value * 100)
}

function number(value: unknown) {
  const parsed = Number(value ?? 0)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("Usage утга буруу байна")
  return parsed
}
