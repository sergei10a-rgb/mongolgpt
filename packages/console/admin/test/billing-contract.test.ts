import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { AdminBillingQueryInput, adminBillingPeriodBounds } from "../src/lib/admin-billing"

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

  test("keeps billing read-only, permission-gated, and based on the authoritative ledgers", async () => {
    const billing = await source("src/lib/admin-billing.ts")
    const route = await source("src/routes/billing/index.tsx")
    const header = await source("src/component/admin-header.tsx")

    expect(billing).toContain('"billing.read"')
    expect(billing).toContain("PaymentInvoiceTable")
    expect(billing).toContain("PlanSubscriptionTable")
    expect(billing).toContain("UsageTable")
    expect(billing).toContain("PaymentInvoiceTable.time_verified")
    expect(billing).toContain("PaymentInvoiceTable.time_refunded")
    expect(billing).toContain("lte(PlanSubscriptionTable.timePeriodStart, period.end)")
    expect(billing).toContain("gt(PlanSubscriptionTable.timePeriodEnd, period.end)")
    expect(billing).toContain("isNull(PaymentInvoiceTable.timeDeleted)")
    expect(billing).toContain("isNull(UsageTable.timeDeleted)")
    expect(billing).toContain("'$.plan'")
    expect(billing).toContain("<> 'byok'")
    expect(billing).toContain("lte(UsageTable.timeCreated, period.end)")
    expect(billing).not.toContain("PaymentTable")
    expect(route).toContain("Санхүүгийн хяналт")
    expect(route).not.toContain("action(")
    expect(header).toContain('permissions.includes("billing.read")')
    expect(header).toContain('href="/billing"')
  })

  test("shows native currencies and refuses to present an invented gross margin", async () => {
    const view = await source("src/component/admin-billing.tsx")

    expect(view).toContain("Цэвэр орлого")
    expect(view).toContain("MongolGPT-ийн загварын өртөг")
    expect(view).toContain("Нийт ашигт ажиллагаа")
    expect(view).toContain("Тооцоолоогүй")
    expect(view).toContain("Түүхэн USD/MNT ханш, шимтгэлийн бүртгэл шаардлагатай")
    expect(view).toContain('currency: "MNT"')
    expect(view).toContain('currency: "USD"')
    expect(view).not.toContain("opencode")
    expect(view).not.toContain("Stripe")
  })
})
