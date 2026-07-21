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

  test("keeps retired Zen marketing and OpenCode media out of active console surfaces", async () => {
    const home = await Bun.file(new URL("src/routes/index.tsx", consoleApp)).text()
    const download = await Bun.file(new URL("src/routes/download/index.tsx", consoleApp)).text()
    const logout = await Bun.file(new URL("src/routes/auth/logout.ts", consoleApp)).text()
    const workspace = await Bun.file(new URL("src/routes/workspace/[id].tsx", consoleApp)).text()
    const models = await Bun.file(new URL("src/routes/workspace/[id]/model-section.tsx", consoleApp)).text()
    const usage = await Bun.file(new URL("src/routes/workspace/[id]/usage/usage-section.tsx", consoleApp)).text()
    const graph = await Bun.file(new URL("src/routes/workspace/[id]/usage/graph-section.tsx", consoleApp)).text()
    const gateway = await Bun.file(new URL("src/routes/zen/util/handler.ts", consoleApp)).text()
    const members = await Bun.file(new URL("src/routes/workspace/[id]/members/member-section.tsx", consoleApp)).text()
    const localeDirectory = new URL("src/i18n/", consoleApp)
    const localeFiles = (await readdir(localeDirectory)).filter((name) => name.endsWith(".ts") && name !== "index.ts")

    expect(home).toContain("mongolgpt-product-session.png")
    expect(home).toContain('i18n.t("home.pricingCta.title")')
    expect(home).toContain('language.route("/pricing")')
    expect(home).not.toContain("mongolgpt-min.mp4")
    expect(home).not.toContain("home.zenCta")
    expect(home).not.toContain('language.route("/zen")')

    expect(download).toContain('language.route("/docs/providers/")')
    expect(download).toContain('language.route("/pricing")')
    expect(download).not.toContain('language.route("/zen")')
    expect(download).not.toContain('i18n.t("nav.zen")')

    expect(logout).toContain('redirect("/pricing")')
    expect(workspace).toContain('i18n.t("workspace.nav.models")')
    expect(workspace).not.toContain('i18n.t("workspace.nav.zen")')
    expect(models).toContain('language.route("/docs/providers/")')
    expect(members).toContain('language.route("/docs/enterprise/")')
    expect(usage).toContain('i18n.t("workspace.usage.legacyPlan"')
    expect(usage).not.toContain('i18n.t("workspace.usage.lite"')
    expect(graph).toContain('i18n.t("workspace.cost.legacyPlanShort")')
    expect(graph).not.toContain('" (go)"')
    expect(gateway).toContain('consolePath("/pricing")')
    expect(gateway).toContain("/billing`)")
    expect(gateway).not.toContain('consolePath("/go")')

    for (const name of localeFiles) {
      const locale = await Bun.file(new URL(name, localeDirectory)).text()
      const keys = [...locale.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1])
      const retired = keys.filter(
        (key) =>
          key.startsWith("temp.") ||
          key.startsWith("go.") ||
          (key.startsWith("zen.") && !key.startsWith("zen.api.error.")) ||
          key.startsWith("home.zenCta.") ||
          key.startsWith("workspace.referral.") ||
          (key.startsWith("workspace.lite.") && !key.startsWith("workspace.lite.time.")) ||
          ["nav.zen", "nav.go", "workspace.nav.zen", "workspace.nav.go", "workspace.usage.lite"].includes(key),
      )

      expect(retired).toEqual([])
      expect(locale).not.toContain("MongolGPT Go")
      expect(locale).not.toContain("MongolGPT Zen")
    }

    expect(await Bun.file(new URL("src/routes/temp.tsx", consoleApp)).exists()).toBe(false)
    expect(await Bun.file(new URL("public/social-share-zen.png", consoleApp)).exists()).toBe(false)
    expect(await Bun.file(new URL("src/asset/lander/mongolgpt-product-session.png", consoleApp)).exists()).toBe(true)
    for (const name of [
      "mongolgpt-min.mp4",
      "mongolgpt-poster.png",
      "mongolgpt-comparison-min.mp4",
      "mongolgpt-comparison-poster.png",
      "screenshot.png",
      "screenshot-vscode.png",
      "screenshot-splash.png",
      "screenshot-github.png",
    ]) {
      expect(await Bun.file(new URL(`src/asset/lander/${name}`, consoleApp)).exists()).toBe(false)
    }
  })
})
