import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { Database } from "../src/drizzle"
import { listWorkspaceUsageWithDb } from "../src/workspace-usage"

const WORKSPACE_A = "wrk_usage_history_a"
const WORKSPACE_B = "wrk_usage_history_b"

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

describe("workspace usage history", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun SQLite implements the D1 subset used by the query
    const db = drizzle({ client: sqlite }) as unknown as Database.TxOrDb
    const insert = sqlite.query(
      `insert into usage
        (id, workspace_id, model, provider, input_tokens, output_tokens, cost, time_created, time_updated, time_deleted)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run("usg_01JV5T0G9H5Q3N7S2R8M4K6WXA", WORKSPACE_A, "model-a", "provider-a", 10, 20, 30, 1_000, 1_000, null)
    insert.run("usg_01JV5T0G9H5Q3N7S2R8M4K6WXB", WORKSPACE_A, "model-b", "provider-b", 40, 50, 60, 2_000, 2_000, null)
    insert.run("usg_01JV5T0G9H5Q3N7S2R8M4K6WXE", WORKSPACE_A, "model-c", "provider-c", 41, 51, 61, 2_000, 2_000, null)
    insert.run(
      "usg_01JV5T0G9H5Q3N7S2R8M4K6WXC",
      WORKSPACE_B,
      "private-model",
      "private-provider",
      70,
      80,
      90,
      3_000,
      3_000,
      null,
    )
    insert.run(
      "usg_01JV5T0G9H5Q3N7S2R8M4K6WXD",
      WORKSPACE_A,
      "deleted-model",
      "provider-a",
      1,
      1,
      1,
      4_000,
      4_000,
      4_100,
    )
    return { db }
  }

  test("returns only visible rows from the requested workspace in deterministic order", async () => {
    const { db } = await fixture()
    const rows = await listWorkspaceUsageWithDb(db, WORKSPACE_A, 0, 50)

    expect(rows.map((row) => row.model)).toEqual(["model-c", "model-b", "model-a"])
    expect(JSON.stringify(rows)).not.toContain("private")
    expect(JSON.stringify(rows)).not.toContain("deleted-model")
  })

  test("bounds pagination without crossing workspaces", async () => {
    const { db } = await fixture()

    expect((await listWorkspaceUsageWithDb(db, WORKSPACE_A, 0, 1))[0]?.model).toBe("model-c")
    expect((await listWorkspaceUsageWithDb(db, WORKSPACE_A, 1, 1))[0]?.model).toBe("model-b")
    expect((await listWorkspaceUsageWithDb(db, WORKSPACE_A, 2, 1))[0]?.model).toBe("model-a")
    expect((await listWorkspaceUsageWithDb(db, WORKSPACE_B, 0, 50))[0]?.model).toBe("private-model")
    expect(await listWorkspaceUsageWithDb(db, WORKSPACE_A, -1, 50).catch((error) => error)).toBeInstanceOf(Error)
    expect(await listWorkspaceUsageWithDb(db, WORKSPACE_A, 0, 101).catch((error) => error)).toBeInstanceOf(Error)
  })
})
