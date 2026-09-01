import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { AdminWorkspaceInvestigationInput, requireAdminWorkspaceInvestigationAccess } from "../src/lib/admin-workspaces"

async function source(path: string) {
  return Bun.file(resolve(import.meta.dir, "..", path)).text()
}

function context(permissions: PlatformAdminContext["permissions"]): PlatformAdminContext {
  return {
    id: "adm_01K3ABCDEFGHJKMNPQRSTVWXYZ",
    email: "admin@mgpt.mn",
    subject: "access-subject",
    role: "administrator",
    permissions,
    requestID: "request-1",
    bootstrapped: false,
  }
}

describe("admin workspace investigation contract", () => {
  test("bounds search, cursor, selected workspace, and page size", () => {
    expect(
      AdminWorkspaceInvestigationInput.parse({
        q: " wrk_01K3ABCDEFGHJKMNPQRSTVWXYZ ",
        workspace: "wrk_01K3ABCDEFGHJKMNPQRSTVWXYZ",
        limit: 25,
      }),
    ).toMatchObject({
      q: "wrk_01K3ABCDEFGHJKMNPQRSTVWXYZ",
      workspace: "wrk_01K3ABCDEFGHJKMNPQRSTVWXYZ",
      limit: 25,
    })
    expect(AdminWorkspaceInvestigationInput.safeParse({ q: "x".repeat(101) }).success).toBe(false)
    expect(AdminWorkspaceInvestigationInput.safeParse({ limit: 100 }).success).toBe(false)
    expect(AdminWorkspaceInvestigationInput.safeParse({ cursor: "wrk_not_valid" }).success).toBe(false)
    expect(AdminWorkspaceInvestigationInput.safeParse({ workspace: "acc_01K3ABCDEFGHJKMNPQRSTVWXYZ" }).success).toBe(
      false,
    )
  })

  test("fails closed unless both users.read and billing.read are present", () => {
    expect(() => requireAdminWorkspaceInvestigationAccess(context(["users.read", "billing.read"]))).not.toThrow()
    expect(() => requireAdminWorkspaceInvestigationAccess(context(["users.read"]))).toThrow(
      "Энэ үйлдлийг хийх админы эрх хүрэлцэхгүй байна.",
    )
    expect(() => requireAdminWorkspaceInvestigationAccess(context(["billing.read"]))).toThrow(
      "Энэ үйлдлийг хийх админы эрх хүрэлцэхгүй байна.",
    )
  })

  test("keeps the query bounded, escaped, soft-paginated, and read-only", async () => {
    const [workspaces, route, header, quotaClient, infra] = await Promise.all([
      source("src/lib/admin-workspaces.ts"),
      source("src/routes/workspaces/index.tsx"),
      source("src/component/admin-header.tsx"),
      source("src/lib/admin-quota.server.ts"),
      source("../../../infra/admin-standalone.ts"),
    ])

    expect(workspaces).toContain('"users.read"')
    expect(workspaces).toContain('"billing.read"')
    expect(workspaces).toContain("escapeLike")
    expect(workspaces).toContain("input.limit + 1")
    expect(workspaces).toContain(".limit(100)")
    expect(workspaces).toContain("isNull(WorkspaceTable.timeDeleted)")
    expect(workspaces).toContain("isNull(UserTable.timeDeleted)")
    expect(workspaces).toContain("isNull(PaymentInvoiceTable.timeDeleted)")
    expect(workspaces).toContain("isNull(PlanSubscriptionTable.timeDeleted)")
    expect(workspaces).toContain("gte(UsageTable.timeCreated, usagePeriod.usageStart)")
    expect(workspaces).toContain("lt(UsageTable.timeCreated, usagePeriod.usageEnd)")
    expect(workspaces).toContain("groupBy(UsageTable.provider, UsageTable.model)")
    expect(workspaces).toContain("readPaidPlanQuota")
    expect(workspaces).toContain("SubscriptionTable")
    expect(workspaces).toContain('mode: "paid-plan"')
    expect(workspaces).toContain('mode: "model-scoped"')
    expect(workspaces).not.toContain("inArray(")
    expect(workspaces).not.toContain(".insert(")
    expect(workspaces).not.toContain(".update(")
    expect(workspaces).not.toContain(".delete(")
    expect(workspaces).not.toContain("requireSameOriginAdminMutation")
    expect(route).toContain("Ажлын орон зайн шалгалт")
    expect(route).toContain("adminWorkspacesQuery")
    expect(route).toContain("Дэлгэрэнгүй")
    expect(route).toContain("aria-label")
    expect(route).toContain("Сүүлийн 30 хоногийн хэрэглээ")
    expect(route).toContain("Гишүүн тус бүрийн багцын хязгаар")
    expect(route).toContain("Хуурамч үлдэгдэл")
    expect(route).not.toContain("bounded хайлт")
    expect(route).not.toContain("usage бүртгэл")
    expect(route).not.toContain("action(")
    expect(route).not.toContain("useSubmission")
    expect(route).not.toContain("opencode")
    expect(quotaClient).toContain("Resource.QuotaServiceToken.value")
    expect(quotaClient).toContain("Authorization: `Bearer ${resources.token}`")
    expect(infra).toContain('importedSecretValue("QuotaServiceToken"')
    expect(infra).not.toContain("RandomPassword")
    expect(header).toContain('permissions.includes("users.read") && props.admin.permissions.includes("billing.read")')
    expect(header).toContain('href="/workspaces"')
  })
})
