import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"

const routes = new URL("../../console/app/src/routes/", import.meta.url)
const consoleApp = new URL("../../console/app/", import.meta.url)
const consoleCore = new URL("../../console/core/", import.meta.url)

describe("hosted console legacy route contract", () => {
  test("retires the Black storefront behind a static home redirect", async () => {
    const redirect = await Bun.file(new URL("black.tsx", routes)).text()
    const legacyFiles = [
      "black.css",
      "black/common.tsx",
      "black/index.tsx",
      "black/workspace.css",
      "black/workspace.tsx",
      "black/subscribe/[plan].tsx",
    ]

    expect(redirect).toContain('<Navigate href="/" />')
    expect(redirect).not.toContain("use server")
    for (const path of legacyFiles) expect(await Bun.file(new URL(path, routes)).exists()).toBe(false)
  })

  test("keeps retired Black branding out of active console surfaces", async () => {
    const localeDirectory = new URL("src/i18n/", consoleApp)
    const localeFiles = (await readdir(localeDirectory)).filter((name) => name.endsWith(".ts") && name !== "index.ts")
    const usage = await Bun.file(new URL("src/routes/workspace/[id]/usage/usage-section.tsx", consoleApp)).text()

    expect(localeFiles).toHaveLength(19)
    for (const name of localeFiles) {
      const locale = await Bun.file(new URL(name, localeDirectory)).text()
      expect(locale).not.toContain('"black.')
      expect(locale).not.toContain('"workspace.black.')
      expect(locale).not.toContain('"workspace.lite.black.message"')
      expect(locale).not.toContain("MongolGPT Black")
      expect(locale).toContain('"workspace.usage.subscription": "{{plan}} (${{amount}})"')
    }

    expect(usage).toContain("plan: subscriptionPlanName(usage.enrichment?.plan)")
    expect(await Bun.file(new URL("public/social-share-black.png", consoleApp)).exists()).toBe(false)
  })

  test("preserves legacy plan-code compatibility for historical records", async () => {
    const schema = await Bun.file(new URL("src/schema-d1/index.ts", consoleCore)).text()
    expect(schema).toContain('LegacyPlanCodes = ["20", "100", "200"] as const')
  })

  test("replaces Go and Zen storefronts with locale-aware pricing redirects", async () => {
    for (const name of ["go", "zen"]) {
      const redirect = await Bun.file(new URL(`${name}/index.tsx`, routes)).text()
      expect(redirect).toContain('language.route("/pricing")')
      expect(redirect).not.toContain("use server")
      expect(await Bun.file(new URL(`${name}/index.css`, routes)).exists()).toBe(false)
    }

    expect(await Bun.file(new URL("zen/v1/models.ts", routes)).exists()).toBe(true)
    expect(await Bun.file(new URL("zen/go/v1/models.ts", routes)).exists()).toBe(true)
  })

  test("publishes config-backed Free, Basic, Pro, and Max pricing", async () => {
    const pricing = await Bun.file(new URL("pricing/index.tsx", routes)).text()
    const header = await Bun.file(new URL("src/component/header.tsx", consoleApp)).text()
    const billing = await Bun.file(
      new URL("src/routes/workspace/[id]/billing/subscription-section.tsx", consoleApp),
    ).text()

    expect(pricing).toContain("PaymentPlanCatalogSchema")
    expect(pricing).toContain("Resource.PaymentConfig")
    expect(pricing).toContain('id: "free"')
    expect(pricing).toContain('id: "basic"')
    expect(pricing).toContain('id: "pro"')
    expect(pricing).toContain('id: "max"')
    expect(pricing).toContain('currency: "MNT"')
    expect(pricing).not.toMatch(/[₮$]\s*[1-9][0-9,._]*/)

    expect(header).toContain('language.route("/pricing")')
    expect(header).not.toContain('language.route("/go")')
    expect(header).not.toContain('language.route("/zen")')
    expect(header).not.toContain('language.route("/data")')
    expect(header).not.toContain("zen?: boolean")
    expect(header).not.toContain("go?: boolean")

    expect(billing).toContain('const planOrder = ["basic", "pro", "max"] as const')
    expect(billing).toContain('const providerNames = { qpay: "QPay", bonum: "Bonum" } as const')
  })
})
