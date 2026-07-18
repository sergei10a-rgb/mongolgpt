import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { resolve } from "node:path"

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []

  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) {
    paths.push(path)
  }

  const migrations = await Promise.all(paths.sort().map((path) => Bun.file(path).text()))
  return migrations.join("\n")
}

describe("D1 migration", () => {
  test("applies cleanly to SQLite", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())

    const tables = database
      .query("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name")
      .values()

    expect(tables).toHaveLength(27)
    expect(tables).toContainEqual(["account"])
    expect(tables).toContainEqual(["enterprise_inquiry"])
    expect(tables).toContainEqual(["newsletter_subscriber"])
    expect(tables).toContainEqual(["payment_event"])
    expect(tables).toContainEqual(["payment_invoice"])
    expect(tables).toContainEqual(["workspace"])
  })

  test("enforces enum and JSON constraints", async () => {
    const database = new Database(":memory:")
    database.exec(await migrationSql())

    expect(() =>
      database
        .query("insert into auth (id, provider, subject, account_id) values (?, ?, ?, ?)")
        .run("auth-id", "invalid", "subject", "account-id"),
    ).toThrow()

    expect(() =>
      database
        .query("insert into billing (id, workspace_id, balance, subscription) values (?, ?, ?, ?)")
        .run("billing-id", "workspace-id", 0, "{"),
    ).toThrow()
  })
})
