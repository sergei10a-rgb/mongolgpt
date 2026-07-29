import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  AdminBillingQueryInput,
  adminBillingPeriodBounds,
  adminBillingSafeDifference,
  adminBillingSafeSum,
} from "../src/lib/admin-billing"

async function source(path: string) {
  return Bun.file(resolve(import.meta.dir, "..", path)).text()
}

describe("admin billing contract", () => {
  test("bounds the report period and payment filters", () => {
    expect(
      AdminBillingQueryInput.parse({
        period: "90d",
        provider: "qpay",
        status: "refunded",
      }),
    ).toEqual({
      period: "90d",
      provider: "qpay",
      status: "refunded",
    })
    expect(AdminBillingQueryInput.parse({})).toEqual({
      period: "30d",
      provider: "all",
      status: "all",
    })
    expect(AdminBillingQueryInput.safeParse({ period: "365d" }).success).toBe(false)
    expect(AdminBillingQueryInput.safeParse({ provider: "stripe" }).success).toBe(false)
    expect(AdminBillingQueryInput.safeParse({ status: "chargeback" }).success).toBe(false)
  })

  test("uses exact rolling UTC instants without mutating the report clock", () => {
    const now = new Date("2026-07-29T12:00:00.000Z")
    const bounds = adminBillingPeriodBounds("30d", now)

    expect(bounds.start.toISOString()).toBe("2026-06-29T12:00:00.000Z")
    expect(bounds.end).toBe(now)
    expect(now.toISOString()).toBe("2026-07-29T12:00:00.000Z")
  })

  test("rejects aggregate arithmetic outside the safe integer range", () => {
    expect(adminBillingSafeSum(10, 20, 30)).toBe(60)
    expect(adminBillingSafeDifference(10, 30)).toBe(-20)
    expect(() => adminBillingSafeSum(Number.MAX_SAFE_INTEGER, 1)).toThrow("аюулгүй бүхэл тооны хязгаараас")
    expect(() => adminBillingSafeDifference(Number.MIN_SAFE_INTEGER, 1)).toThrow("аюулгүй бүхэл тооны хязгаараас")
    expect(() => adminBillingSafeSum(Number.MAX_SAFE_INTEGER + 1)).toThrow("хүчинтэй бүхэл тоо биш")
  })

  test("keeps billing read-only, permission-gated, and based on the authoritative ledgers", async () => {
    const billing = await source("src/lib/admin-billing.ts")
    const finance = await source("../core/src/finance-reporting.ts")
    const route = await source("src/routes/billing/index.tsx")
    const header = await source("src/component/admin-header.tsx")

    expect(billing).toContain('"billing.read"')
    expect(billing).toContain("PaymentInvoiceTable")
    expect(billing).toContain("PlanSubscriptionTable")
    expect(billing).toContain("UsageTable")
    expect(billing).toContain("getFinanceMarginEvidenceWithDb")
    expect(billing).toContain("calculateFinanceGrossMargin")
    expect(billing).toContain("PaymentInvoiceTable.time_verified")
    expect(billing).toContain("PaymentInvoiceTable.time_refunded")
    expect(billing).toContain("lte(PlanSubscriptionTable.timePeriodStart, period.end)")
    expect(billing).toContain("gt(PlanSubscriptionTable.timePeriodEnd, period.end)")
    expect(billing).toContain("isNull(PaymentInvoiceTable.timeDeleted)")
    expect(billing).toContain("isNull(UsageTable.timeDeleted)")
    expect(billing).toContain("'$.plan'")
    expect(billing).toContain("<> 'byok'")
    expect(billing).toContain("lt(UsageTable.timeCreated, period.end)")
    expect(billing).not.toContain("PaymentTable")
    expect(finance).toContain("FinanceCostEntryTable")
    expect(finance).toContain("FinancePaymentSettlementTable")
    expect(finance).toContain("finance_cost_valuation")
    expect(finance).toContain("basis = 'actual'")
    expect(finance).toContain("payment_provider_filter")
    expect(route).toContain("Санхүүгийн хяналт")
    expect(route).not.toContain("action(")
    expect(header).toContain('permissions.includes("billing.read")')
    expect(header).toContain('href="/billing"')
  })

  test("shows actual and estimated costs separately and refuses to invent an incomplete margin", async () => {
    const view = await source("src/component/admin-billing.tsx")

    expect(view).toContain("Цэвэр орлого")
    expect(view).toContain("Загварын бодит өртөг")
    expect(view).toContain("Загварын урьдчилсан өртөг")
    expect(view).toContain("Төлбөрийн шимтгэл ба татвар")
    expect(view).toContain("Нийт ашигт ажиллагаа")
    expect(view).toContain("Тооцоолоогүй")
    expect(view).toContain("Зарим хэрэглээний бодит өртөг дутуу")
    expect(view).toContain("Зарим төлбөрийн тооцоо нийлүүлэлтийн баримт дутуу")
    expect(view).toContain('currency: "MNT"')
    expect(view).toContain('currency: "USD"')
    expect(view).not.toContain("opencode")
    expect(view).not.toContain("Stripe")
  })
})
