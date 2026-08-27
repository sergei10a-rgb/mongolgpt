import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import {
  AccountOverviewSuspendedError,
  AccountOverviewWorkspaceAccessError,
  getAccountOverviewWithDb,
  type AccountOverviewDependencies,
} from "../src/account-overview"
import { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

const NOW = Date.UTC(2026, 7, 19, 12)
const ACCOUNT_ID = "acc_overview_owner"
const PAID_WORKSPACE = "wrk_overview_paid"
const FREE_WORKSPACE = "wrk_overview_free"
const PAID_USER = "usr_overview_paid"
const FREE_USER = "usr_overview_free"

const limits: AccountOverviewDependencies = {
  getFreeLimits: () => ({
    promoTokens: 1_000,
    dailyRequests: 20,
    dailyRequestsFallback: 5,
    checkHeaders: { "x-internal": "must-not-leak" },
  }),
  getPlanLimits: (plan) => ({
    weeklyCostLimit: plan === "basic" ? 2 : 5,
    weeklyTokenLimit: plan === "basic" ? 100_000 : 500_000,
    weeklyRequestLimit: plan === "basic" ? 300 : 1_000,
    monthlyCostLimit: plan === "basic" ? 20 : 50,
    monthlyTokenLimit: plan === "basic" ? 900_000 : 2_500_000,
    monthlyRequestLimit: plan === "basic" ? 2_000 : 6_000,
    rollingCostLimit: plan === "basic" ? 1 : 2,
    rollingWindow: 5,
  }),
}

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

async function fixture() {
  const sqlite = new SQLite(":memory:")
  sqlite.exec(await migrationSql())
  const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun SQLite implements the D1 query subset
  const db = drizzleDb as unknown as Database.TxOrDb

  sqlite
    .query("insert into account (id, time_created, time_updated) values (?, ?, ?)")
    .run(ACCOUNT_ID, NOW - 30 * 86_400_000, NOW - 30 * 86_400_000)
  sqlite.query("insert into workspace (id, name, slug) values (?, ?, ?)").run(PAID_WORKSPACE, "Багийн орчин", "team")
  sqlite.query("insert into workspace (id, name, slug) values (?, ?, ?)").run(FREE_WORKSPACE, "Хувийн орчин", null)
  sqlite
    .query("insert into user (id, workspace_id, account_id, email, name, role) values (?, ?, ?, ?, ?, ?)")
    .run(PAID_USER, PAID_WORKSPACE, ACCOUNT_ID, "owner@mgpt.mn", "Owner", "admin")
  sqlite
    .query("insert into user (id, workspace_id, account_id, email, name, role) values (?, ?, ?, ?, ?, ?)")
    .run(FREE_USER, FREE_WORKSPACE, ACCOUNT_ID, "owner@mgpt.mn", "Owner", "member")
  sqlite
    .query(
      "insert into plan_subscription (id, workspace_id, invoice_id, plan, status, time_period_start, time_period_end) values (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "sub_overview_paid",
      PAID_WORKSPACE,
      "inv_overview_paid",
      "basic",
      "active",
      NOW - 86_400_000,
      NOW + 20 * 86_400_000,
    )
  sqlite
    .query(
      "insert into plan_subscription (id, workspace_id, invoice_id, plan, status, time_period_start, time_period_end) values (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "sub_overview_future",
      FREE_WORKSPACE,
      "inv_overview_future",
      "max",
      "active",
      NOW + 86_400_000,
      NOW + 31 * 86_400_000,
    )
  sqlite
    .query(
      `insert into subscription
        (id, workspace_id, user_id, fixed_usage, weekly_tokens, weekly_requests,
          monthly_cost, monthly_tokens, monthly_requests, rolling_usage,
          time_fixed_updated, time_weekly_tokens_updated, time_weekly_requests_updated,
          time_monthly_cost_updated, time_monthly_tokens_updated, time_monthly_requests_updated,
          time_rolling_updated)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "sub_overview_usage",
      PAID_WORKSPACE,
      PAID_USER,
      100,
      200,
      230,
      1_000,
      1_500,
      1_800,
      300,
      ...Array(7).fill(NOW - 1_000),
    )

  const insertUsage = sqlite.query(
    `insert into usage
      (id, workspace_id, model, provider, input_tokens, output_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cost, time_created, time_updated, time_deleted)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertUsage.run(
    "usg_overview_paid",
    PAID_WORKSPACE,
    "paid-model",
    "openrouter",
    10,
    20,
    3,
    4,
    5,
    6,
    700,
    NOW - 1_000,
    NOW - 1_000,
    null,
  )
  insertUsage.run(
    "usg_overview_old",
    PAID_WORKSPACE,
    "old-model",
    "openrouter",
    999,
    999,
    0,
    0,
    0,
    0,
    999,
    NOW - 2 * 86_400_000,
    NOW - 2 * 86_400_000,
    null,
  )
  insertUsage.run(
    "usg_overview_deleted",
    PAID_WORKSPACE,
    "deleted-model",
    "openrouter",
    888,
    888,
    0,
    0,
    0,
    0,
    888,
    NOW - 500,
    NOW - 500,
    NOW - 100,
  )
  insertUsage.run(
    "usg_overview_free",
    FREE_WORKSPACE,
    "free-auto",
    "nvidia",
    7,
    8,
    null,
    null,
    null,
    null,
    0,
    NOW - 2_000,
    NOW - 2_000,
    null,
  )

  sqlite.query("insert into account (id) values (?)").run("acc_overview_other")
  sqlite.query("insert into workspace (id, name) values (?, ?)").run("wrk_overview_other", "Нууц орчин")
  sqlite
    .query("insert into user (id, workspace_id, account_id, name, role) values (?, ?, ?, ?, ?)")
    .run("usr_overview_other", "wrk_overview_other", "acc_overview_other", "Other", "admin")

  return { sqlite, db }
}

describe("account overview", () => {
  test("returns isolated workspace plan, live quota, and real usage without leaking internal free headers", async () => {
    const { db } = await fixture()
    const overview = await getAccountOverviewWithDb(
      db,
      {
        accountID: ACCOUNT_ID,
        email: "owner@mgpt.mn",
        currentWorkspaceID: PAID_WORKSPACE,
        now: NOW,
      },
      {
        ...limits,
        readPlanQuota: async ({ scope, keys }) => {
          expect(scope).toBe("plan:wrk_overview_paid:inv_overview_paid")
          return Object.fromEntries(keys.map((key, index) => [key, [150, 180, 220, 900, 1_400, 1_700, 350][index]]))
        },
      },
    )

    expect(overview.currentWorkspaceID).toBe(PAID_WORKSPACE)
    expect(overview.workspaces.map((item) => item.id)).toEqual([PAID_WORKSPACE, FREE_WORKSPACE])
    expect(JSON.stringify(overview)).not.toContain("wrk_overview_other")
    expect(JSON.stringify(overview)).not.toContain("x-internal")
    const paid = overview.workspaces.find((item) => item.id === PAID_WORKSPACE)
    expect(paid?.subscription).toMatchObject({ plan: "basic", invoiceID: "inv_overview_paid" })
    expect(paid?.limits).toEqual({
      plan: "basic",
      weeklyCostLimitInMicroCents: 200_000_000,
      weeklyTokenLimit: 100_000,
      weeklyRequestLimit: 300,
      monthlyCostLimitInMicroCents: 2_000_000_000,
      monthlyTokenLimit: 900_000,
      monthlyRequestLimit: 2_000,
      rollingCostLimitInMicroCents: 100_000_000,
      rollingWindowHours: 5,
    })
    expect(paid?.quota).toMatchObject({
      status: "available",
      scope: "user",
      weeklyCost: { used: 150, limit: 200_000_000 },
      weeklyTokens: { used: 200, limit: 100_000 },
      weeklyRequests: { used: 230, limit: 300 },
      monthlyCost: { used: 1_000, limit: 2_000_000_000 },
      monthlyTokens: { used: 1_500, limit: 900_000 },
      monthlyRequests: { used: 1_800, limit: 2_000 },
      rollingCost: { used: 350, limit: 100_000_000 },
    })
    expect(paid?.usage).toMatchObject({
      scope: "workspace",
      period: "subscription",
      requestCount: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 48,
      costInMicroCents: 700,
    })

    const free = overview.workspaces.find((item) => item.id === FREE_WORKSPACE)
    expect(free?.subscription).toBeNull()
    expect(free?.limits).toEqual({ plan: "free", promoTokens: 1_000, dailyRequests: 20, dailyRequestsFallback: 5 })
    expect(free?.quota).toEqual({ status: "model-scoped", reason: "free-auto-model-limits" })
    expect(free?.usage.totalTokens).toBe(15)
  })

  test("does not invent live quota when the Durable Object ledger is unavailable", async () => {
    const { db } = await fixture()
    const overview = await getAccountOverviewWithDb(
      db,
      { accountID: ACCOUNT_ID, email: "owner@mgpt.mn", currentWorkspaceID: PAID_WORKSPACE, now: NOW },
      {
        ...limits,
        readPlanQuota: async () => {
          throw new Error("quota unavailable")
        },
      },
    )
    expect(overview.workspaces.find((item) => item.id === PAID_WORKSPACE)?.quota).toEqual({
      status: "unavailable",
      reason: "quota-service-unavailable",
    })
  })

  test("requires an owned current workspace and rejects suspended accounts", async () => {
    const { sqlite, db } = await fixture()
    expect(
      await getAccountOverviewWithDb(
        db,
        { accountID: ACCOUNT_ID, email: "owner@mgpt.mn", currentWorkspaceID: "wrk_overview_other", now: NOW },
        limits,
      ).catch((error) => error),
    ).toBeInstanceOf(AccountOverviewWorkspaceAccessError)

    sqlite
      .query(
        "update account set status = 'suspended', suspension_reason = ?, suspended_by = ?, time_suspended = ? where id = ?",
      )
      .run("Security review", "acc_overview_other", NOW, ACCOUNT_ID)
    expect(
      await getAccountOverviewWithDb(db, { accountID: ACCOUNT_ID, email: "owner@mgpt.mn", now: NOW }, limits).catch(
        (error) => error,
      ),
    ).toBeInstanceOf(AccountOverviewSuspendedError)
  })
})
