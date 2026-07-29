import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { AccountAccess } from "../src/account-access"
import { AccountAccessPolicy } from "../src/account-access-policy"
import type { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

const active = {
  id: "acc_01K2A3B4C5D6E7F8G9H0J1K2M3",
  status: "active" as const,
  auth_version: 3,
  timeDeleted: null,
}

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

describe("account access", () => {
  test("allows only the current active credential version", () => {
    expect(AccountAccessPolicy.evaluate(active, 3)).toEqual({
      allowed: true,
      accountID: active.id,
      authVersion: 3,
    })
    expect(AccountAccessPolicy.evaluate(active, 2)).toEqual({
      allowed: false,
      reason: "revoked",
    })
  })

  test("denies suspended, deleted, and missing accounts", () => {
    expect(AccountAccessPolicy.evaluate({ ...active, status: "suspended" }, 3)).toEqual({
      allowed: false,
      reason: "suspended",
    })
    expect(AccountAccessPolicy.evaluate({ ...active, timeDeleted: new Date() }, 3)).toEqual({
      allowed: false,
      reason: "missing",
    })
    expect(AccountAccessPolicy.evaluate(undefined, 3)).toEqual({
      allowed: false,
      reason: "missing",
    })
  })

  test("validates and normalizes an administrative transition", () => {
    expect(
      AccountAccessPolicy.Transition.parse({
        accountID: active.id,
        adminID: "adm_01K2A3B4C5D6E7F8G9H0J1K2M3",
        status: "suspended",
        reason: "  Давтагдсан   үйлчилгээний нөхцөл зөрчсөн.  ",
      }),
    ).toMatchObject({
      reason: "Давтагдсан үйлчилгээний нөхцөл зөрчсөн.",
    })

    expect(
      AccountAccessPolicy.Transition.safeParse({
        accountID: active.id,
        adminID: "adm_01K2A3B4C5D6E7F8G9H0J1K2M3",
        status: "suspended",
        reason: "богино",
      }).success,
    ).toBe(false)
  })

  test("revokes API keys permanently when an account is suspended", async () => {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the test adapter implements the D1 subset
    const db = drizzleDb as unknown as Database.TxOrDb
    const workspaceID = "wrk_account_access"
    const userID = "usr_account_access"
    const keyID = "key_account_access"

    sqlite.query("insert into account (id) values (?)").run(active.id)
    sqlite.query("insert into workspace (id, name) values (?, ?)").run(workspaceID, "Access test")
    sqlite
      .query("insert into user (id, workspace_id, account_id, name, role) values (?, ?, ?, ?, ?)")
      .run(userID, workspaceID, active.id, "Test", "admin")
    sqlite
      .query("insert into key (id, workspace_id, name, key, user_id) values (?, ?, ?, ?, ?)")
      .run(keyID, workspaceID, "Before suspension", "mgpt_test_key", userID)

    const suspended = await AccountAccess.transition(db, {
      accountID: active.id,
      adminID: "adm_01K2A3B4C5D6E7F8G9H0J1K2M3",
      status: "suspended",
      reason: "Үйлчилгээний нөхцөл зөрчсөн туршилтын шалтгаан.",
    })
    expect(suspended).toMatchObject({
      changed: true,
      authVersion: 1,
      revokedApiKeys: 1,
    })

    const reactivated = await AccountAccess.transition(db, {
      accountID: active.id,
      adminID: "adm_01K2A3B4C5D6E7F8G9H0J1K2M3",
      status: "active",
      reason: "Админ шалгаж дахин идэвхжүүлсэн туршилтын шалтгаан.",
    })
    expect(reactivated).toMatchObject({
      changed: true,
      authVersion: 1,
      revokedApiKeys: 0,
    })
    expect(sqlite.query("select time_deleted from key where id = ?").get(keyID)).toEqual({
      time_deleted: expect.any(Number),
    })
  })
})
