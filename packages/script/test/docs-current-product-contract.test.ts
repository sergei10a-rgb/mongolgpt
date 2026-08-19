import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"

const docs = new URL("../../web/src/content/docs/", import.meta.url)
const astro = new URL("../../web/astro.config.mjs", import.meta.url)
const legacyRedirects = new URL("../../web/legacy-mn-redirects.mjs", import.meta.url)
const mobileMenu = new URL("../../web/src/components/MobileMenuToggle.astro", import.meta.url)
const install = new URL("../../../install", import.meta.url)
const productSourceRoots = [
  new URL("../../app/src/i18n/", import.meta.url),
  new URL("../../mongolgpt/src/", import.meta.url),
  new URL("../../sdk/js/src/", import.meta.url),
  new URL("../../web/src/", import.meta.url),
]

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

async function textSourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory)
      if (entry.isDirectory()) return textSourceFiles(child)
      return /\.(?:[cm]?[jt]sx?|mdx?|json|txt)$/.test(entry.name) ? [child] : []
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
    const legacy = await Bun.file(legacyRedirects).text()
    const sidebar = config.slice(config.indexOf("sidebar:"), config.indexOf("components:"))

    expect(account).toContain("mongolgpt console login")
    expect(account).toContain("MongolGPT Free Auto")
    expect(account).toContain("Basic, Pro, Max")
    expect(account).toContain("Үйлдвэрлэлийн үйлчилгээ")
    expect(sidebar).toContain('"account"')
    expect(sidebar).not.toMatch(/["'](?:go|zen)["']/)
    expect(config.match(/"\/(?:go|zen)": "\/docs\/account"/g)).toHaveLength(2)
    expect(legacy).toContain('"/mn": "/docs/"')
    expect(legacy).not.toMatch(/["'](?:go|zen)["']/)
    expect(await Bun.file(new URL("go.mdx", docs)).exists()).toBe(false)
    expect(await Bun.file(new URL("zen.mdx", docs)).exists()).toBe(false)
  })

  test("publishes dedicated Mongolian service, privacy, billing, and admin guidance", async () => {
    const [faq, privacy, billing, admin, config] = await Promise.all([
      Bun.file(new URL("faq.mdx", docs)).text(),
      Bun.file(new URL("privacy.mdx", docs)).text(),
      Bun.file(new URL("billing.mdx", docs)).text(),
      Bun.file(new URL("admin.mdx", docs)).text(),
      Bun.file(astro).text(),
    ])
    const sidebar = config.slice(config.indexOf("sidebar:"), config.indexOf("components:"))

    expect(sidebar).toContain('label: "MongolGPT үйлчилгээ"')
    for (const page of ["faq", "privacy", "billing", "admin"]) expect(sidebar).toContain(`"${page}"`)
    expect(faq).toContain("албан ёсны `app.mgpt.mn`")
    expect(faq).toContain("байршуулсан ажиллах орчны тохиргоо буруу")
    expect(privacy).toContain("зөвхөн дотоодод ажиллах сессийг байршуулсан хадгалалтад заавал хадгална гэж")
    expect(billing).toContain("QPay")
    expect(billing).toContain("Bonum")
    expect(billing).toContain("### Туршилтын орчин")
    expect(billing).toContain("### Үйлдвэрлэлийн орчин")
    expect(admin).toContain("## Одоогийн хязгаарлалт")
    expect(admin).toContain("буцаан олголт")
  })

  test("documents only the hosted SaaS deploy path and every runtime trust secret", async () => {
    const deployment = await Bun.file(new URL("deployment.mdx", docs)).text()

    expect(deployment).toContain('$env:MONGOLGPT_ENABLE_HOSTED_SERVICES="true"')
    expect(deployment).not.toContain('$env:MONGOLGPT_ENABLE_HOSTED_SERVICES="false"')
    expect(deployment).toContain("`MONGOLGPT_RUNTIME_SECRET`")
    expect(deployment).toContain("`MONGOLGPT_RUNTIME_AUTH_SECRET`")
    expect(deployment).toContain("хоорондоо ялгаатай хоёр тогтвортой нууц утга")
    expect(deployment).toContain("криптографын аюулгүй санамсаргүй үүсгүүрээр")
    expect(deployment).toContain("https://auth.dev.mgpt.mn/github/callback")
    expect(deployment).toContain("https://auth.dev.mgpt.mn/google/callback")
    expect(deployment).toContain("https://auth.mgpt.mn/github/callback")
    expect(deployment).toContain("https://auth.mgpt.mn/google/callback")
    expect(deployment).toContain("GET https://runtime.mgpt.mn/global/health")
  })

  test("keeps repository documentation links on canonical Mongolian sources", async () => {
    const files = [install, ...(await Promise.all(productSourceRoots.map(textSourceFiles))).flat()]
    const sources = await Promise.all(files.map((file) => Bun.file(file).text()))
    for (const source of sources) expect(source).not.toContain("packages/web/src/content/docs/mn")
  })

  test("keeps the mobile navigation state accessible", async () => {
    const config = await Bun.file(astro).text()
    const component = await Bun.file(mobileMenu).text()

    expect(config).toContain('MobileMenuToggle: "./src/components/MobileMenuToggle.astro"')
    expect(component).toContain('this.btn.setAttribute("aria-expanded", String(expanded))')
    expect(component).toContain('aria-controls="starlight__sidebar"')
  })
})
