import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const source = (path: string) => Bun.file(resolve(import.meta.dir, "..", "src", path)).text()

describe("home landing contract", () => {
  test("keeps the MongolGPT-first hero and real product screenshot", async () => {
    const view = await source("routes/index.tsx")
    expect(view).toContain("<h1>MongolGPT</h1>")
    expect(view).toContain("mongolgpt-product-session.png")
    expect(view).toContain('aria-label="Бүтээгдэхүүний үндсэн боломжууд"')
    expect(view).not.toContain('aria-label="Core product pillars"')
    expect(view).toContain("Монгол хэрэглэгчийн хиймэл оюуны кодын агент")
    expect(view).not.toContain("Tabs")
    expect(view).not.toContain("EmailSignup")
    expect(view).not.toContain("Live product preview")
    expect(view).not.toContain("Next step")
  })

  test("links primary calls to real account, docs, pricing, and download routes", async () => {
    const view = await source("routes/index.tsx")
    expect(view).toContain('href="/auth"')
    expect(view).toContain('language.route("/download")')
    expect(view).toContain('language.route("/docs")')
    expect(view).toContain('language.route("/docs/cli")')
    expect(view).toContain('language.route("/docs/providers/")')
    expect(view).toContain('language.route("/pricing")')
    expect(view).toContain('href: "/support"')
  })

  test("keeps header and footer aligned to the public product routes", async () => {
    const header = await source("component/header.tsx")
    const footer = await source("component/footer.tsx")
    expect(header).toContain('language.route("/support")')
    expect(header).toContain('language.route("/download")')
    expect(footer).toContain('language.route("/download")')
    expect(footer).toContain('i18n.t("footer.support")')
  })

  test("keeps Mongolian public copy free from internal English feature labels", async () => {
    const publicCopy = await Promise.all([
      source("i18n/mn.ts"),
      source("routes/index.tsx"),
      source("routes/download/index.tsx"),
      source("routes/pricing/index.tsx"),
    ])
    const text = publicCopy.join("\n")
    expect(text).not.toContain("Free Auto")
    expect(text).not.toContain("OpenAI-compatible")
    expect(text).not.toMatch(/\bCLI\b/)
  })

  test("uses the new home layout structure and keyboard-visible focus styling", async () => {
    const styles = await source("routes/index.css")
    expect(styles).toContain('[data-component="hero-grid"]')
    expect(styles).toContain('[data-component="pillar-band"]')
    expect(styles).toContain('[data-component="launch-grid"]')
    expect(styles).toContain("a:focus-visible")
    expect(styles).toContain("border-radius: 8px")
    expect(styles).not.toMatch(/font-size:\s*clamp\([^)]*vw/)
  })

  test("reports the live mobile menu state to assistive technology", async () => {
    const header = await source("component/header.tsx")
    expect(header).toContain("aria-expanded={store.mobileMenuOpen}")
    expect(header).not.toContain('aria-expanded="false"')
  })
})
