import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import type { Database } from "@mongolgpt/console-core/drizzle/index.js"
import * as schema from "@mongolgpt/console-core/schema-d1/index.js"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { listAdminWorkspacesWithDb, type AdminWorkspaceDependencies } from "../src/lib/admin-workspaces"

const NOW = new Date(Date.UTC(2026, 7, 30, 12))
const WORKSPACE_ID = "wrk_01K3ABCDEFGHJKMNPQRSTVWXYZ"
const USER_ID = "usr_workspace_quota_owner"

const admin: PlatformAdminContext = {
  id: "adm_01K3ABCDEFGHJKMNPQRSTVWXYZ",
  email: "admin@mgpt.mn",
  subject: "access-subject",
  role: "administrator",
  permissions: ["users.read", "billing.read"],
  requestID: "request-1",
  bootstrapped: false,
}

const dependencies: AdminWorkspaceDependencies = {
  getPlanLimits: () => ({
    weeklyCostLimit: 2,
    weeklyTokenLimit: 100_000,
    weeklyRequestLimit: 300,
    monthlyCostLimit: 20,
    monthlyTokenLimit: 900_000,
    monthlyRequestLimit: 2_000,
    rollingCostLimit: 1,
    rollingWindow: 5,
  }),
  readPlanQuota: async ({ scope, keys }) => {
    expect(scope).toBe(`plan:${WORKSPACE_ID}:inv_workspace_quota`)
    return Object.fromEntries(keys.map((key, index) => [key, [150, 180, 220, 900, 1_400, 1_700, 350][index]]))
  },
}

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../../core/migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

async function fixture(extraConnectedMembers = 0) {
  const sqlite = new SQLite(":memory:")
  sqlite.exec(await migrationSql())
  const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
  const db = drizzleDb as unknown as Database.TxOrDb

  sqlite.query("insert into account (id) values (?)").run("acc_workspace_quota_owner")
  sqlite.query("insert into workspace (id, name, slug) values (?, ?, ?)").run(WORKSPACE_ID, "Quota баг", "quota-team")
  sqlite
    .query("insert into user (id, workspace_id, account_id, email, name, role) values (?, ?, ?, ?, ?, ?)")
    .run(USER_ID, WORKSPACE_ID, "acc_workspace_quota_owner", "owner@mgpt.mn", "Эзэмшигч", "admin")
  sqlite
    .query("insert into user (id, workspace_id, email, name, role) values (?, ?, ?, ?, ?)")
    .run("usr_workspace_quota_pending", WORKSPACE_ID, "pending@mgpt.mn", "Хүлээгдэж буй", "member")
  Array.from({ length: extraConnectedMembers }, (_, index) => index + 1).forEach((index) => {
    sqlite.query("insert into account (id) values (?)").run(`acc_workspace_quota_${index}`)
    sqlite
      .query("insert into user (id, workspace_id, account_id, email, name, role) values (?, ?, ?, ?, ?, ?)")
      .run(
        `usr_workspace_quota_${index}`,
        WORKSPACE_ID,
        `acc_workspace_quota_${index}`,
        `member${index}@mgpt.mn`,
        `Гишүүн ${index}`,
        "member",
      )
  })
  sqlite
    .query(
      "insert into plan_subscription (id, workspace_id, invoice_id, plan, status, time_period_start, time_period_end) values (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "sub_workspace_quota",
      WORKSPACE_ID,
      "inv_workspace_quota",
      "basic",
      "active",
      NOW.getTime() - 86_400_000,
      NOW.getTime() + 20 * 86_400_000,
    )
  sqlite
    .query(
      "insert into plan_subscription (id, workspace_id, invoice_id, plan, status, time_period_start, time_period_end) values (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "sub_workspace_quota_cancelled",
      WORKSPACE_ID,
      "inv_workspace_quota_cancelled",
      "max",
      "cancelled",
      NOW.getTime() - 86_400_000,
      NOW.getTime() + 40 * 86_400_000,
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
      "sub_workspace_quota_usage",
      WORKSPACE_ID,
      USER_ID,
      100,
      200,
      230,
      1_000,
      1_500,
      1_800,
      300,
      ...Array(7).fill(NOW.getTime() - 1_000),
    )

  return { sqlite, db }
}

describe("admin workspace live quota", () => {
  test("returns honest per-member live quota and excludes an unconnected invitation", async () => {
    const { db } = await fixture()
    const result = await listAdminWorkspacesWithDb(db, admin, { workspace: WORKSPACE_ID }, NOW, dependencies)

    expect(result.selectedWorkspace?.quota.mode).toBe("paid-plan")
    if (result.selectedWorkspace?.quota.mode !== "paid-plan") throw new Error("paid plan expected")
    expect(result.selectedWorkspace.quota.members).toHaveLength(1)
    expect(result.selectedWorkspace.quota.members[0]).toMatchObject({
      id: USER_ID,
      accountID: "acc_workspace_quota_owner",
      quota: {
        status: "available",
        scope: "user",
        weeklyCost: { used: 150, limit: 200_000_000 },
        weeklyTokens: { used: 200, limit: 100_000 },
        weeklyRequests: { used: 230, limit: 300 },
        monthlyCost: { used: 1_000, limit: 2_000_000_000 },
        monthlyTokens: { used: 1_500, limit: 900_000 },
        monthlyRequests: { used: 1_800, limit: 2_000 },
        rollingCost: { used: 350, limit: 100_000_000 },
      },
    })
  })

  test("marks the member quota unavailable instead of inventing a balance", async () => {
    const { db } = await fixture()
    const result = await listAdminWorkspacesWithDb(db, admin, { workspace: WORKSPACE_ID }, NOW, {
      ...dependencies,
      readPlanQuota: async () => {
        throw new Error("quota unavailable")
      },
    })

    if (result.selectedWorkspace?.quota.mode !== "paid-plan") throw new Error("paid plan expected")
    expect(result.selectedWorkspace.quota.members[0]?.quota).toEqual({
      status: "unavailable",
      reason: "quota-service-unavailable",
    })
  })

  test("batches a multi-member ledger read into at most 64 keys per request", async () => {
    const { db } = await fixture(9)
    let reads = 0
    const result = await listAdminWorkspacesWithDb(db, admin, { workspace: WORKSPACE_ID }, NOW, {
      ...dependencies,
      readPlanQuota: async ({ scope, keys }) => {
        reads += 1
        expect(scope).toBe(`plan:${WORKSPACE_ID}:inv_workspace_quota`)
        expect(keys.length).toBeLessThanOrEqual(64)
        return Object.fromEntries(keys.map((key) => [key, 0]))
      },
    })

    if (result.selectedWorkspace?.quota.mode !== "paid-plan") throw new Error("paid plan expected")
    expect(result.selectedWorkspace.quota.members).toHaveLength(10)
    expect(reads).toBe(2)
  })
})
