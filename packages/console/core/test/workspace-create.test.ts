import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import type { Database as CoreDatabase } from "../src/drizzle"
import { Workspace } from "../src/workspace"
import { AccountTable, BillingTable, KeyTable, UserTable, WorkspaceTable } from "../src/schema-d1"

const schema = { AccountTable, BillingTable, KeyTable, UserTable, WorkspaceTable }

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
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- D1 and Bun SQLite expose the same Drizzle query surface for this invariant test.
  const db = drizzleDb as unknown as CoreDatabase.TxOrDb
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The harness executes D1-style batch builders inside one Bun SQLite transaction.
  const batch = (async (callback: (tx: CoreDatabase.TxOrDb) => readonly PromiseLike<unknown>[]) => {
    sqlite.exec("BEGIN IMMEDIATE")
    try {
      const result = []
      for (const statement of callback(db)) {
        if (!("_prepare" in statement) || typeof statement._prepare !== "function") {
          throw new Error("D1 batch item must be a deferred Drizzle query")
        }
        result.push(await statement)
      }
      sqlite.exec("COMMIT")
      return result
    } catch (error) {
      sqlite.exec("ROLLBACK")
      throw error
    }
  }) as unknown as typeof CoreDatabase.batch
  return { sqlite, batch }
}

describe("D1 workspace creation", () => {
  test("creates workspace, owner, billing, and default key atomically", async () => {
    const { sqlite, batch } = await fixture()
    sqlite.query("insert into account (id) values (?)").run("acc_workspace")

    const workspaceID = await Workspace.createForAccount({ accountID: "acc_workspace", name: "Миний орчин" }, batch)

    expect(sqlite.query("select id, name from workspace").get()).toEqual({ id: workspaceID, name: "Миний орчин" })
    expect(sqlite.query('select workspace_id, account_id, role from "user"').get()).toEqual({
      workspace_id: workspaceID,
      account_id: "acc_workspace",
      role: "admin",
    })
    expect(sqlite.query("select workspace_id, balance from billing").get()).toEqual({
      workspace_id: workspaceID,
      balance: 0,
    })
    expect(sqlite.query('select workspace_id, name, length("key") as length from "key"').get()).toEqual({
      workspace_id: workspaceID,
      name: "Default API Key",
      length: 67,
    })
  })

  test("rolls back every record when the account is inactive", async () => {
    const { sqlite, batch } = await fixture()

    const failure = await Workspace.createForAccount({ accountID: "acc_missing", name: "Миний орчин" }, batch).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)

    for (const table of ["workspace", "user", "billing", "key"]) {
      expect(sqlite.query(`select count(*) as count from "${table}"`).get()).toEqual({ count: 0 })
    }
  })
})
