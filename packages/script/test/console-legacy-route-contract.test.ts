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
})
