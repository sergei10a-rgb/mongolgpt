import { AccountOverviewSchema, PlanNames, type AccountOverview } from "@mongolgpt/account-contract"
import { and, Database, eq, gt, gte, isNull, lt, lte, sql } from "./drizzle"
import {
  planCostLimitInMicroCents,
  readPaidPlanQuota,
  type PaidPlanQuotaLimits,
  type ReadPlanQuota,
} from "./paid-plan-quota"
import { AccountTable } from "./schema/account.sql"
import { PlanSubscriptionTable, SubscriptionTable, UsageTable } from "./schema/billing.sql"
import { UserTable } from "./schema/user.sql"
import { WorkspaceTable } from "./schema/workspace.sql"
import { Subscription } from "./subscription"
import { getMonthlyBounds, getWeekBounds } from "./util/date"
import { z } from "zod"

const inputSchema = z
  .object({
    accountID: z.string().trim().min(5).max(30).regex(/^acc_/),
    email: z.string().trim().email().max(320),
    currentWorkspaceID: z.string().trim().min(5).max(30).regex(/^wrk_/).optional(),
    now: z.number().int().nonnegative().optional(),
  })
  .strict()

type FreeLimits = z.output<typeof Subscription.LimitsSchema>["free"]

export type AccountOverviewDependencies = {
  getFreeLimits?: () => FreeLimits | Promise<FreeLimits>
  getPlanLimits?: (plan: (typeof PlanNames)[number]) => PaidPlanQuotaLimits | Promise<PaidPlanQuotaLimits>
  readPlanQuota?: ReadPlanQuota
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

export const AccountOverviewUnavailableStages = ["account", "memberships", "limits", "workspaces", "response"] as const

export type AccountOverviewUnavailableStage = (typeof AccountOverviewUnavailableStages)[number]

export class AccountOverviewUnavailableError extends Error {
  constructor(
    readonly stage: AccountOverviewUnavailableStage,
    options?: ErrorOptions,
  ) {
    super(`Account overview unavailable at ${stage}`, options)
    this.name = "AccountOverviewUnavailableError"
  }
}

async function operationalStage<T>(stage: AccountOverviewUnavailableStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (
      error instanceof AccountOverviewNotFoundError ||
      error instanceof AccountOverviewSuspendedError ||
      error instanceof AccountOverviewWorkspaceAccessError ||
      error instanceof AccountOverviewUnavailableError
    ) {
      throw error
    }
    throw new AccountOverviewUnavailableError(stage, { cause: error })
  }
}

const accountIDSchema = z.string().trim().min(5).max(30).regex(/^acc_/)

export type AccountWorkspace = {
  id: string
  name: string
}

export function listActiveAccountWorkspaces(accountID: string): Promise<AccountWorkspace[]> {
  return Database.use((db) => listActiveAccountWorkspacesWithDb(db, accountID))
}

export async function listActiveAccountWorkspacesWithDb(
  db: Database.TxOrDb,
  rawAccountID: string,
): Promise<AccountWorkspace[]> {
  const accountID = accountIDSchema.parse(rawAccountID)
  const account = await db
    .select({ status: AccountTable.status })
    .from(AccountTable)
    .where(and(eq(AccountTable.id, accountID), isNull(AccountTable.timeDeleted)))
    .limit(1)
    .then((rows) => rows[0])
  if (!account) throw new AccountOverviewNotFoundError()
  if (account.status === "suspended") throw new AccountOverviewSuspendedError()

  return db
    .select({ id: WorkspaceTable.id, name: WorkspaceTable.name })
    .from(UserTable)
    .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, UserTable.workspaceID))
    .where(and(eq(UserTable.accountID, accountID), isNull(UserTable.timeDeleted), isNull(WorkspaceTable.timeDeleted)))
    .orderBy(WorkspaceTable.name, WorkspaceTable.id)
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
  const account = await operationalStage("account", () =>
    db
      .select({
        id: AccountTable.id,
        status: AccountTable.status,
        createdAt: AccountTable.timeCreated,
      })
      .from(AccountTable)
      .where(and(eq(AccountTable.id, input.accountID), isNull(AccountTable.timeDeleted)))
      .limit(1)
      .then((rows) => rows[0]),
  )
  if (!account) throw new AccountOverviewNotFoundError()
  if (account.status === "suspended") throw new AccountOverviewSuspendedError()

  const memberships = await operationalStage("memberships", () =>
    db
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
        and(
          eq(UserTable.accountID, input.accountID),
          isNull(UserTable.timeDeleted),
          isNull(WorkspaceTable.timeDeleted),
        ),
      )
      .orderBy(WorkspaceTable.name, WorkspaceTable.id),
  )

  if (input.currentWorkspaceID && !memberships.some((item) => item.id === input.currentWorkspaceID)) {
    throw new AccountOverviewWorkspaceAccessError()
  }
  const currentWorkspaceID = input.currentWorkspaceID ?? (memberships.length === 1 ? memberships[0].id : null)
  const { freeLimits, getPlanLimits } = await operationalStage("limits", async () => {
    const runtimeLimits =
      dependencies.getFreeLimits && dependencies.getPlanLimits ? undefined : await Subscription.getLimits()
    return {
      freeLimits: dependencies.getFreeLimits ? await dependencies.getFreeLimits() : runtimeLimits!.free,
      getPlanLimits: dependencies.getPlanLimits
        ? dependencies.getPlanLimits
        : async (plan: (typeof PlanNames)[number]) => runtimeLimits!.plans[plan],
    }
  })
  const week = getWeekBounds(current)
  const workspaces = await operationalStage("workspaces", () =>
    Promise.all(
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

        const limits = await getPlanLimits(active.plan)
        const month = getMonthlyBounds(current, new Date(active.periodStart))
        return {
          id: item.id,
          name: item.name,
          slug: item.slug,
          userID: item.userID,
          role: item.role,
          subscription: active,
          limits: {
            plan: active.plan,
            weeklyCostLimitInMicroCents: planCostLimitInMicroCents(limits.weeklyCostLimit),
            weeklyTokenLimit: limits.weeklyTokenLimit,
            weeklyRequestLimit: limits.weeklyRequestLimit,
            monthlyCostLimitInMicroCents: planCostLimitInMicroCents(limits.monthlyCostLimit),
            monthlyTokenLimit: limits.monthlyTokenLimit,
            monthlyRequestLimit: limits.monthlyRequestLimit,
            rollingCostLimitInMicroCents: planCostLimitInMicroCents(limits.rollingCostLimit),
            rollingWindowHours: limits.rollingWindow,
          },
          quota: await readPaidPlanQuota(
            item,
            active.invoiceID,
            limits,
            now,
            week.end.getTime(),
            month.start.getTime(),
            month.end.getTime(),
            dependencies.readPlanQuota,
          ),
          usage,
        }
      }),
    ),
  )

  return operationalStage("response", async () =>
    AccountOverviewSchema.parse({
      account: {
        id: account.id,
        email: input.email,
        status: "active",
        createdAt: account.createdAt.getTime(),
      },
      currentWorkspaceID,
      workspaces,
    }),
  )
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

function number(value: unknown) {
  const parsed = Number(value ?? 0)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("Usage утга буруу байна")
  return parsed
}
