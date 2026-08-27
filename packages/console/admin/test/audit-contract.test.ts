import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { AdminAuditDirectoryInput } from "../src/lib/admin-audit"

async function source(path: string) {
  return Bun.file(resolve(import.meta.dir, "..", path)).text()
}

describe("admin audit directory contract", () => {
  test("bounds search, result filter, cursor, and page size", () => {
    expect(
      AdminAuditDirectoryInput.parse({
        q: " account.suspend ",
        outcome: "denied",
        limit: 50,
      }),
    ).toMatchObject({ q: "account.suspend", outcome: "denied", limit: 50 })
    expect(AdminAuditDirectoryInput.safeParse({ q: "x".repeat(101) }).success).toBe(false)
    expect(AdminAuditDirectoryInput.safeParse({ outcome: "unknown" }).success).toBe(false)
    expect(AdminAuditDirectoryInput.safeParse({ limit: 100 }).success).toBe(false)
    expect(AdminAuditDirectoryInput.safeParse({ cursor: "aud_invalid" }).success).toBe(false)
  })

  test("keeps the directory read-only, permission-gated, and metadata-minimal", async () => {
    const library = await source("src/lib/admin-audit.ts")
    const route = await source("src/routes/audit/index.tsx")
    const header = await source("src/component/admin-header.tsx")

    expect(library).toContain('requirePlatformAdminPermission(context, "audit.read")')
    expect(library).toContain("escape '\\'")
    expect(library).not.toContain("AdminAuditLogTable.metadata,")
    expect(library).not.toContain("AdminAuditLogTable.user_agent")
    expect(library).not.toMatch(/\.insert\(|\.update\(|\.delete\(/)
    expect(route).toContain("Админы үйлдлийн бүртгэл")
    expect(route).toContain("Өөрчлөх боломжгүй бүртгэл")
    expect(route).toContain("aria-label")
    expect(header).toContain('permissions.includes("audit.read")')
    expect(header).toContain('href="/audit"')
    expect(route).not.toContain("opencode")
  })
})
