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

  test("links primary calls to localized auth, docs, pricing, and download routes", async () => {
    const view = await source("routes/index.tsx")
    expect(view).toContain('language.route("/auth")')
    expect(view).not.toContain('href="/auth"')
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
    expect(header).toContain('language.route("/auth")')
    expect(header).toContain('target="_blank" rel="noreferrer"')
    expect(header).not.toContain('href="/auth"')
    expect(header).not.toContain('language.route("/enterprise")')
    expect(footer).toContain('language.route("/download")')
    expect(footer).toContain('language.route("/pricing")')
    expect(footer).toContain('language.route("/support")')
    expect(footer).toContain("resolveCommunityLink")
    expect(footer).toContain('target="_blank" rel="noreferrer"')
    expect(footer).not.toContain('href="/auth"')
    expect(footer).toContain('i18n.t("footer.support")')
    expect(footer).toContain('i18n.t("footer.github")')
    expect(footer).not.toContain("starCount")
    expect(footer).not.toContain("githubData")
  })

  test("keeps landing copy free from generic English product jargon", async () => {
    const text = await source("routes/index.tsx")
    const quoted =
      text
        .match(/"[^"]*"/g)
        ?.filter((value) => /[А-Яа-яЁёӨөҮү]/.test(value))
        .join("\n") ?? ""
    expect(text).not.toContain("Free Auto")
    expect(text).not.toContain("OpenAI-compatible")
    expect(text).not.toMatch(/\bCLI\b/)
    expect(quoted).not.toMatch(/\baccount\b/i)
    expect(quoted).not.toMatch(/\bdesktop\b/i)
    expect(quoted).not.toMatch(/\bsupport\b/i)
    expect(quoted).not.toMatch(/\bdocs\b/i)
    expect(quoted).not.toMatch(/\bprovider\b/i)
    expect(quoted).not.toMatch(/\bendpoint\b/i)
    expect(quoted).not.toMatch(/\blocal model\b/i)
    expect(quoted).not.toMatch(/\bskill\b/i)
    expect(quoted).not.toMatch(/\bplugin\b/i)
    expect(quoted).not.toMatch(/\bBYOK\b/)
    expect(quoted).not.toMatch(/\bproduction (flow|runtime)\b/i)
  })

  test("uses the new home layout structure and keyboard-visible focus styling", async () => {
    const styles = await source("routes/index.css")
    expect(styles).toContain('[data-component="hero-grid"]')
    expect(styles).toContain('[data-component="pillar-band"]')
    expect(styles).toContain('[data-component="readiness-band"]')
    expect(styles).toContain('[data-component="launch-grid"]')
    expect(styles).toContain("a:focus-visible")
    expect(styles).toContain("border-radius: 8px")
    expect(styles).not.toMatch(/font-size:\s*clamp\([^)]*vw/)
  })

  test("keeps the mobile hero compact enough to reveal visual and next-section cues", async () => {
    const styles = await source("routes/index.css")
    expect(styles).toContain('[data-slot="hero-actions"] {')
    expect(styles).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(styles).toContain('[data-slot="hero-actions"] [data-variant="ghost"] {')
    expect(styles).toContain("grid-column: 1 / -1;")
    expect(styles).toContain("max-height: 8.8rem;")
    expect(styles).toContain('[data-component="hero-nav"] {')
    expect(styles).toContain("overflow-x: auto;")
  })

  test("reports the live mobile menu state to assistive technology", async () => {
    const header = await source("component/header.tsx")
    expect(header).toContain("aria-expanded={store.mobileMenuOpen}")
    expect(header).not.toContain('aria-expanded="false"')
  })

  test("ships real social share and manifest assets instead of workspace pointer files", async () => {
    const publicDir = resolve(import.meta.dir, "..", "public")
    const share = Bun.file(resolve(publicDir, "social-share.png"))
    const manifest = Bun.file(resolve(publicDir, "site.webmanifest"))
    const icon192 = Bun.file(resolve(publicDir, "web-app-manifest-192x192.png"))
    const icon512 = Bun.file(resolve(publicDir, "web-app-manifest-512x512.png"))

    expect(share.size).toBeGreaterThan(1_000)
    expect(icon192.size).toBeGreaterThan(1_000)
    expect(icon512.size).toBeGreaterThan(1_000)

    const manifestText = await manifest.text()
    expect(manifestText).toContain('"name":"MongolGPT"')
    expect(manifestText.trim().startsWith("{")).toBe(true)
    expect(manifestText).not.toContain("../../../")
  })
})
