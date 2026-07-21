import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"

const docs = new URL("../../web/src/content/docs/", import.meta.url)
const astro = new URL("../../web/astro.config.mjs", import.meta.url)
const mobileMenu = new URL("../../web/src/components/MobileMenuToggle.astro", import.meta.url)

async function markdownFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory)
      if (entry.isDirectory()) return markdownFiles(child)
      return /\.mdx?$/.test(entry.name) ? [child] : []
    }),
  )
  return files.flat()
}

describe("documentation product contract", () => {
  test("keeps retired managed-product names and endpoints out of published docs", async () => {
    for (const file of await markdownFiles(docs)) {
      const source = await Bun.file(file).text()
      expect(source).not.toMatch(/MongolGPT (?:Zen|Go|Black)\b/i)
      expect(source).not.toMatch(/mgpt\.mn\/zen/i)
      expect(source).not.toMatch(/\/docs\/(?:zen|go)\b/i)
      expect(source).not.toContain("MONGOLGPT_GO_URL")
      expect(source).not.toMatch(/MongolGPT account.{0,100}(?:дэмжигдэхгүй|хэрэггүй)/i)
    }
  })

  test("publishes the current account guide and removes retired pages from navigation", async () => {
    const account = await Bun.file(new URL("account.mdx", docs)).text()
    const config = await Bun.file(astro).text()
    const sidebar = config.slice(config.indexOf("sidebar:"), config.indexOf("components:"))

    expect(account).toContain("mongolgpt console login")
    expect(account).toContain("MongolGPT Free Auto")
    expect(account).toContain("Basic, Pro, Max")
    expect(account).toContain("Production үйлчилгээ")
    expect(sidebar).toContain('"account"')
    expect(sidebar).not.toMatch(/["'](?:go|zen)["']/)
    expect(config.match(/"\/(?:go|zen|mn\/go|mn\/zen)": "\/docs\/account"/g)).toHaveLength(4)
    expect(await Bun.file(new URL("go.mdx", docs)).exists()).toBe(false)
    expect(await Bun.file(new URL("zen.mdx", docs)).exists()).toBe(false)
  })

  test("keeps the mobile navigation state accessible", async () => {
    const config = await Bun.file(astro).text()
    const component = await Bun.file(mobileMenu).text()

    expect(config).toContain('MobileMenuToggle: "./src/components/MobileMenuToggle.astro"')
    expect(component).toContain('this.btn.setAttribute("aria-expanded", String(expanded))')
    expect(component).toContain('aria-controls="starlight__sidebar"')
  })
})
