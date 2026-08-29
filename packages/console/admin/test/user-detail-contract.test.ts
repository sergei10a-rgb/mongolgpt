import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { AdminUserDetailInput, requireAdminUserDetailAccess } from "../src/lib/admin-users"

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

describe("admin user detail contract", () => {
  test("bounds the selected account id", () => {
    expect(AdminUserDetailInput.parse({ accountID: "acc_01K2A3B4C5D6E7F8G9H0J1K2M3" })).toEqual({
      accountID: "acc_01K2A3B4C5D6E7F8G9H0J1K2M3",
    })
    expect(AdminUserDetailInput.safeParse({ accountID: "wrk_01K2A3B4C5D6E7F8G9H0J1K2M3" }).success).toBe(false)
  })

  test("fails closed unless users.read and billing.read are both present", () => {
    expect(() => requireAdminUserDetailAccess(context(["users.read", "billing.read"]))).not.toThrow()
    expect(() => requireAdminUserDetailAccess(context(["users.read"]))).toThrow(
      "Энэ үйлдлийг хийх админы эрх хүрэлцэхгүй байна.",
    )
    expect(() => requireAdminUserDetailAccess(context(["billing.read"]))).toThrow(
      "Энэ үйлдлийг хийх админы эрх хүрэлцэхгүй байна.",
    )
  })

  test("keeps the route read-only and grounded in existing account, workspace, billing, and finance tables", async () => {
    const users = await source("src/lib/admin-users.ts")
    const route = await source("src/routes/users/[accountID].tsx")
    const list = await source("src/routes/users/index.tsx")

    expect(users).toContain('"users.read"')
    expect(users).toContain('"billing.read"')
    expect(users).toContain("Subscription.getLimits()")
    expect(users).toContain("PlanSubscriptionTable")
    expect(users).toContain("SubscriptionTable")
    expect(users).toContain("UsageTable")
    expect(users).toContain("PaymentInvoiceTable")
    expect(users).toContain("PaymentCheckoutTable")
    expect(users).toContain("getFinanceMarginEvidenceWithDb")
    expect(users).toContain("calculateFinanceGrossMargin")
    expect(users).toContain("const invoiceSummary =")
    expect(users).toContain("inArray(UsageTable.userID, userIDs)")
    expect(users).toContain("eq(PaymentCheckoutTable.account_id, input.accountID)")
    expect(users).toContain("grossMarginMNTMicros")
    expect(users).toContain("marginReasons")
    expect(users).toContain("isNull(WorkspaceTable.timeDeleted)")
    expect(users).not.toContain(".insert(")
    expect(users).not.toContain(".update(")
    expect(users).not.toContain(".delete(")
    expect(route).toContain("Хэрэглэгчийн дэлгэрэнгүй")
    expect(route).toContain("Аккаунтын таних мэдээлэл")
    expect(route).toContain("Төлбөрийн хураангуй")
    expect(route).toContain("Хэрэглээ ба загварын зардлын хураангуй")
    expect(route).not.toContain("Түдгэлзүүлэх")
    expect(route).not.toContain("action(")
    expect(list).toContain('href={`/users/${account.id}`}')
  })
})
