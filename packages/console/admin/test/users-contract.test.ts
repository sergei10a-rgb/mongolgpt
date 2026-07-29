import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { AdminAccountStatusInput, AdminUserDirectoryInput } from "../src/lib/admin-users"

async function source(path: string) {
  return Bun.file(resolve(import.meta.dir, "..", path)).text()
}

describe("admin user management contract", () => {
  test("bounds search, status, cursor, and page size", () => {
    expect(
      AdminUserDirectoryInput.parse({
        q: " user@mgpt.mn ",
        status: "suspended",
        limit: 25,
      }),
    ).toMatchObject({
      q: "user@mgpt.mn",
      status: "suspended",
      limit: 25,
    })
    expect(AdminUserDirectoryInput.safeParse({ q: "x".repeat(101) }).success).toBe(false)
    expect(AdminUserDirectoryInput.safeParse({ limit: 100 }).success).toBe(false)
    expect(AdminUserDirectoryInput.safeParse({ status: "deleted" }).success).toBe(false)
  })

  test("requires a valid account operation and meaningful reason", () => {
    const accountID = "acc_01K2A3B4C5D6E7F8G9H0J1K2M3"
    expect(
      AdminAccountStatusInput.safeParse({
        accountID,
        operation: "suspend",
        reason: "Үйлчилгээний нөхцөлийг давтан зөрчсөн.",
      }).success,
    ).toBe(true)
    expect(
      AdminAccountStatusInput.safeParse({
        accountID,
        operation: "suspend",
        reason: "богино",
      }).success,
    ).toBe(false)
    expect(
      AdminAccountStatusInput.safeParse({
        accountID,
        operation: "delete",
        reason: "Энэ үйлдэл зөвшөөрөгдөхгүй.",
      }).success,
    ).toBe(false)
  })

  test("keeps permission, CSRF, state change, and audit in the server contract", async () => {
    const users = await source("src/lib/admin-users.ts")
    const route = await source("src/routes/users/index.tsx")

    expect(users).toContain('"users.read"')
    expect(users).toContain('"users.suspend"')
    expect(users).toContain("requireSameOriginAdminMutation(request)")
    expect(users).toContain("Database.transaction(async (tx) =>")
    expect(users).toContain("AccountAccess.transition(tx")
    expect(users).toContain("writeAdminAuditWithDb(tx")
    expect(users).toContain('"self_suspend"')
    expect(users).not.toContain("KeyTable")
    expect(users).not.toContain("ProviderTable")
    expect(route).toContain("Хэрэглэгчийн удирдлага")
    expect(route).toContain("Түдгэлзүүлэх")
    expect(route).toContain("Идэвхжүүлэх")
    expect(route).toContain("aria-live")
    expect(route).not.toContain("opencode")
  })
})
