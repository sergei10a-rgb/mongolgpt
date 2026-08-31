import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = (path: string) => readFileSync(resolve(import.meta.dir, "..", "src", path), "utf8")

describe("public route link contract", () => {
  test("pricing page keeps enabled plan CTAs locale-aware and disabled plans non-interactive", () => {
    const pricing = source("routes/pricing/index.tsx")
    expect(pricing).toContain("pricingAuthRoute(plan.id)")
    expect(pricing).toContain("href={language.route(pricingAuthRoute(plan.id))}")
    expect(pricing).toContain('when={plan.id === "free" || pricing()?.enabled}')
    expect(pricing).toContain('data-slot="plan-action" aria-disabled="true"')
    expect(pricing).toContain('i18n.t("pricing.cta.sandbox")')
    expect(pricing).toContain('data-component="pricing-status"')
    expect(pricing).not.toContain('href="/auth"')
  })

  test("support page quick links point to live docs and localized auth", () => {
    const support = source("routes/support/index.tsx")
    expect(support).toContain('language.route("/docs/install/")')
    expect(support).toContain('language.route("/docs/providers/")')
    expect(support).toContain('language.route("/docs/troubleshooting/")')
    expect(support).toContain('href={language.route("/auth")}')
    expect(support).toContain("бүртгэл үүсгэнэ үү")
    expect(support).toContain("Нэвтэрч эсвэл бүртгүүлээд хүсэлт илгээх")
    expect(support).not.toContain('"/docs/getting-started/"')
  })
})
