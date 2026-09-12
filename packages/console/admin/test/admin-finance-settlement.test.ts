import { expect, test } from "bun:test"
import { AdminFinanceSettlementInput, recordAdminFinanceSettlement } from "../src/lib/admin-finance-settlement"
import { hasPlatformAdminPermission, PlatformAdminPermissions } from "../../core/src/platform-admin"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import type { AdminFinanceSettlementDependencies } from "../src/lib/admin-finance-settlement"

test("statement forms retain entered data while query results revalidate", async () => {
  const source = await Bun.file(new URL("../src/routes/billing/settlements/[invoiceID].tsx", import.meta.url)).text()
  expect(source).toContain("current().settlements")
  expect(source).not.toMatch(/when=\{data\(\)\}[^>]*keyed/)
})

const input = {
  invoiceID: `inv_${"1".repeat(26)}`,
  kind: "payment",
  externalSettlementID: "statement-line-1",
  statementReference: "synthetic-merchant-statement-2026-09",
  grossAmountMNT: "100000",
  feeAmountMNT: "1000",
  taxAmountMNT: "100",
  netAmountMNT: "98900",
  effectiveAt: "2026-09-01T09:00",
  confirmation: "verified",
}

test("statement fields require explicit signed integer amounts and a real past Ulaanbaatar time", () => {
  expect(AdminFinanceSettlementInput.parse(input)).toMatchObject({
    effectiveAt: Date.UTC(2026, 8, 1, 1),
    feeAmountMNT: 1000,
  })
  expect(AdminFinanceSettlementInput.parse({ ...input, effectiveAt: "2026-09-01 09:00" }).effectiveAt).toBe(
    Date.UTC(2026, 8, 1, 1),
  )
  for (const key of ["grossAmountMNT", "feeAmountMNT", "taxAmountMNT", "netAmountMNT"])
    for (const value of ["", " ", "NaN", "Infinity", "1e3", "1.5", "1,000", "9007199254740992"])
      expect(AdminFinanceSettlementInput.safeParse({ ...input, [key]: value }).success).toBe(false)
  for (const effectiveAt of ["2026-02-30T12:00", "2099-01-01T01:00", "2026-09-01T25:00", "2026-09-01", "invalid"])
    expect(AdminFinanceSettlementInput.safeParse({ ...input, effectiveAt }).success).toBe(false)
  for (const patch of [
    { confirmation: "" },
    { workspaceID: "foreign" },
    { merchantAccountID: "foreign" },
    { statementReference: "" },
  ])
    expect(AdminFinanceSettlementInput.safeParse({ ...input, ...patch }).success).toBe(false)
  expect(AdminFinanceSettlementInput.parse({ ...input, feeAmountMNT: "0", taxAmountMNT: "-100" })).toMatchObject({
    feeAmountMNT: 0,
    taxAmountMNT: -100,
  })
})

test("settlement writes reject read-only roles and cross-origin requests before touching money", async () => {
  const audits: unknown[] = []
  const dependencies: AdminFinanceSettlementDependencies = {
    batch: async () => {
      throw new Error("Unauthorized database call")
    },
    recordFinancePaymentSettlement: async () => {
      throw new Error("Unauthorized settlement call")
    },
    writeAdminAudit: async (audit) => {
      audits.push(audit)
    },
  }
  for (const role of ["owner", "administrator", "finance", "support", "operations"] as const) {
    const context: PlatformAdminContext = {
      id: `adm_${"1".repeat(26)}`,
      email: `${role}@example.test`,
      subject: "synthetic",
      role,
      permissions: PlatformAdminPermissions.filter((permission) => hasPlatformAdminPermission(role, permission)),
      requestID: "synthetic",
      bootstrapped: false,
    }
    const request = new Request("https://admin.dev.mgpt.mn/billing/settlements", {
      method: "POST",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    })
    expect((await recordAdminFinanceSettlement(context, request, input, dependencies)).ok).toBe(false)
    if (role === "owner" || role === "administrator") continue
    const sameOrigin = new Request(request.url, {
      method: "POST",
      headers: { origin: "https://admin.dev.mgpt.mn", "content-type": "application/x-www-form-urlencoded" },
    })
    const result = await recordAdminFinanceSettlement(context, sameOrigin, input, dependencies)
    expect(result).toEqual({ ok: false, message: "Энэ үйлдлийг хийх админы эрх хүрэлцэхгүй байна." })
  }
  expect(audits).toHaveLength(8)
  expect(audits.every((audit) => (audit as { outcome: string }).outcome === "denied")).toBe(true)
})
