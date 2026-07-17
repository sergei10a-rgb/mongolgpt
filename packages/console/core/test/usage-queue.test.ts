import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { persistUsageQueueEventWithDb } from "../src/usage-queue"
import * as schema from "../src/schema-d1"
import type { UsageQueueEvent } from "../src/quota"

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

const event: UsageQueueEvent = {
  version: 1,
  id: "usage_1",
  workspaceID: "workspace_1",
  userID: "user_1",
  timeCreated: Date.UTC(2026, 6, 17, 1),
  workspaceCost: 125,
  userCost: 125,
  usage: {
    model: "free-auto",
    provider: "nvidia",
    inputTokens: 10,
    outputTokens: 20,
    cost: 125,
    sessionID: "session_1",
    enrichment: { plan: "balance" },
  },
}

describe("Cloudflare usage queue persistence", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const db: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    const compatibleDb = db as unknown as Parameters<typeof persistUsageQueueEventWithDb>[0]
    sqlite.query("insert into workspace (id, name) values (?, ?)").run(event.workspaceID, "Test workspace")
    sqlite
      .query("insert into billing (id, workspace_id, balance, monthly_usage) values (?, ?, ?, ?)")
      .run("billing_1", event.workspaceID, 10_000, 0)
    sqlite
      .query("insert into user (id, workspace_id, name, role, monthly_usage) values (?, ?, ?, ?, ?)")
      .run(event.userID, event.workspaceID, "User", "admin", 0)
    return { sqlite, db: compatibleDb }
  }

  test("writes usage and account balances exactly once", async () => {
    const { sqlite, db } = await fixture()
    await expect(persistUsageQueueEventWithDb(db, event)).resolves.toBe("inserted")
    await expect(persistUsageQueueEventWithDb(db, event)).resolves.toBe("duplicate")

    expect(sqlite.query("select count(*) from usage").get()).toEqual({ "count(*)": 1 })
    expect(sqlite.query("select balance, monthly_usage from billing").get()).toEqual({
      balance: 9_875,
      monthly_usage: 125,
    })
    expect(sqlite.query('select monthly_usage from "user"').get()).toEqual({ monthly_usage: 125 })
  })

  test("does not overwrite a newer monthly counter with a delayed older event", async () => {
    const { sqlite, db } = await fixture()
    sqlite.query("update billing set monthly_usage = ?, time_monthly_usage_updated = ?").run(900, Date.UTC(2026, 7, 2))
    sqlite.query('update "user" set monthly_usage = ?, time_monthly_usage_updated = ?').run(800, Date.UTC(2026, 7, 2))

    await persistUsageQueueEventWithDb(db, event)

    expect(sqlite.query("select balance, monthly_usage from billing").get()).toEqual({
      balance: 9_875,
      monthly_usage: 900,
    })
    expect(sqlite.query('select monthly_usage from "user"').get()).toEqual({ monthly_usage: 800 })
  })
})
