import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  AdminBillingQueryInput,
  AdminSubscriptionCheckoutCancellationInput,
  AdminSubscriptionPaymentRefundInput,
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
    expect(
      AdminSubscriptionCheckoutCancellationInput.safeParse({
        invoiceID: "inv_01JV5T0G9H5Q3N7S2R8M4K6WXA",
        requestKey: "73f8cb79-fd55-4f33-b17b-c2d7452d841f",
        reason: "Давхардсан QPay нэхэмжлэхийг админаас цуцалж байна.",
        confirmation: "cancel",
      }).success,
    ).toBe(true)
    expect(
      AdminSubscriptionCheckoutCancellationInput.safeParse({
        invoiceID: "inv_01JV5T0G9H5Q3N7S2R8M4K6WXA",
        requestKey: "73f8cb79-fd55-4f33-b17b-c2d7452d841f",
        reason: "plain English operator reason that must not be accepted",
        confirmation: "cancel",
      }).success,
    ).toBe(false)
    expect(
      AdminSubscriptionPaymentRefundInput.safeParse({
        invoiceID: "inv_01JV5T0G9H5Q3N7S2R8M4K6WXA",
        requestKey: "22222222-2222-4222-8222-222222222222",
        reason: "Хэрэглэгчийн баталгаажсан хүсэлтээр төлбөрийг бүтнээр буцааж байна.",
        confirmation: "refund",
      }).success,
    ).toBe(true)
    expect(
      AdminSubscriptionPaymentRefundInput.safeParse({
        invoiceID: "inv_01JV5T0G9H5Q3N7S2R8M4K6WXA",
        requestKey: "22222222-2222-4222-8222-222222222222",
        reason: "plain English operator reason that must not be accepted",
        confirmation: "refund",
      }).success,
    ).toBe(false)
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

  test("keeps reporting permission-gated and based on the authoritative ledgers", async () => {
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
    expect(route).toContain("adminBillingQuery")
    expect(header).toContain('permissions.includes("billing.read")')
    expect(header).toContain('href="/billing"')
  })

  test("adds a server-derived, audited QPay cancellation action without client payment scope", async () => {
    const billing = await source("src/lib/admin-billing.ts")
    const view = await source("src/component/admin-billing.tsx")
    const worker = await source("../function/src/payment-webhook.ts")
    const client = await source("src/lib/admin-payment-cancellation.server.ts")

    expect(billing).toContain('"payments.cancel"')
    expect(billing).toContain("requireSameOriginAdminMutation")
    expect(billing).toContain('action: "payments.cancel.requested"')
    expect(billing).toContain("writeAdminAudit")
    expect(billing).toContain("requestPlatformAdminSubscriptionCheckoutCancellation")
    expect(billing).toContain("invoice.cancellationStatus === null")
    expect(billing).toContain('invoice.provider === "qpay"')
    expect(billing).toContain("cancellationRequestKey")
    expect(view).toContain("QPay нэхэмжлэх цуцлах")
    expect(view).toContain("Цуцлах Монгол шалтгаан")
    expect(view).toContain('name="requestKey"')
    expect(view).toContain("invoice.cancellationRequestKey")
    expect(view).toContain("revalidate: adminBillingQuery.key")
    expect(view).toContain("disabled={props.pending}")
    expect(client).toContain("AdminPaymentCancellationToken")
    expect(client).not.toContain("PaymentServiceToken")
    expect(worker).toContain('"/v1/admin/checkouts/subscription/cancel"')
    expect(worker).toContain("adminCancellationToken")
    expect(worker).toContain("PlatformAdminSubscriptionCheckoutCancellationRequestSchema")
  }, 15_000)

  test("adds a server-derived, audited full QPay refund without trusting client money fields", async () => {
    const billing = await source("src/lib/admin-billing.ts")
    const view = await source("src/component/admin-billing.tsx")
    const worker = await source("../function/src/payment-webhook.ts")
    const client = await source("src/lib/admin-payment-refund.server.ts")
    const core = await source("../core/src/payment-refund.ts")

    expect(billing).toContain('"payments.refund"')
    expect(billing).toContain('action: "payments.refund.requested"')
    expect(billing).toContain("requestPlatformAdminSubscriptionPaymentRefund")
    expect(billing).toContain('invoice.refundStatus === "refunded"')
    expect(billing).toContain('invoice.refundStatus === "unknown"')
    expect(billing).toContain("invoice.refundStatus === null || refundNeedsSync || refundNeedsProviderCheck")
    expect(billing).toContain("refundRequestKey")
    expect(view).toContain("QPay төлбөр буцаах")
    expect(view).toContain("Буцаах Монгол шалтгаан")
    expect(view).toContain('value="refund"')
    expect(view).toContain("идэвхтэй багц болон quota-г цуцлах")
    expect(view).toContain("Буцаалтын төлөв сэргээх")
    expect(view).toContain("QPay буцаалтыг шалгах")
    expect(client).toContain("AdminPaymentRefundToken")
    expect(client).not.toContain("PaymentServiceToken")
    expect(worker).toContain('"/v1/admin/payments/subscription/refund"')
    expect(worker).toContain("adminRefundToken")
    expect(worker).toContain("PlatformAdminSubscriptionPaymentRefundRequestSchema")
    expect(core).toContain("PaymentInvoiceTable.amount")
    expect(core).toContain("PaymentInvoiceTable.external_payment_id")
    expect(core).not.toContain("input.amount")
    expect(core).not.toContain("input.externalPaymentID")
  }, 15_000)

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
    expect(view).toContain("Шалтгаан тодорхойгүй")
    expect(view).toContain("Тодорхойгүй төлөв")
    expect(view).toContain('currency: "MNT"')
    expect(view).toContain('currency: "USD"')
    expect(view).not.toContain("opencode")
    expect(view).not.toContain("Stripe")
  })
})
