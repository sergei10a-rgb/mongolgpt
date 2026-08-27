import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  legacyMongolianDocRedirects,
  legacyMongolianDocSlugs,
  normalizeStaticRedirectHtmlDocument,
  staticDocsEntrypointRedirects,
  staticRedirectHtmlDocument,
  writeStaticDocsEntrypointRedirects,
} from "../legacy-mn-redirects.mjs"

const docsRoot = join(import.meta.dir, "..")

test("хуучин Монгол docs source duplicate хадгалагдаагүй байна", () => {
  const legacyDirectory = join(docsRoot, "src", "content", "docs", "mn")
  expect(existsSync(legacyDirectory) ? readdirSync(legacyDirectory) : []).toHaveLength(0)
})

test("хуучин Монгол docs замууд root docs руу redirect-тэй байна", () => {
  const canonicalSlugs = readdirSync(join(docsRoot, "src", "content", "docs"))
    .filter((name) => name.endsWith(".mdx") && name !== "index.mdx")
    .map((name) => name.slice(0, -4))
    .sort()

  expect([...legacyMongolianDocSlugs].sort()).toEqual(canonicalSlugs)
  expect(legacyMongolianDocRedirects["/mn"]).toBe("/docs/")
  for (const slug of legacyMongolianDocSlugs) {
    expect(legacyMongolianDocRedirects[`/mn/${slug}`]).toBe(`/docs/${slug}`)
  }
  expect(legacyMongolianDocRedirects["/mn/index"]).toBeUndefined()
})

test("static redirect HTML нь Монгол хэлтэй бүрэн document байна", () => {
  const source =
    '<!doctype html><meta http-equiv="refresh" content="0;url=/docs/providers/"><body><a href="/docs/providers/">Redirect</a></body>'
  const normalized = normalizeStaticRedirectHtmlDocument(source)

  expect(normalized).toContain('<html lang="mn"><head>')
  expect(normalized).toContain('content="0;url=/docs/providers/"')
  expect(normalized).toEndWith("</body></html>")
  expect(normalizeStaticRedirectHtmlDocument("<!doctype html><html><body>Canonical</body></html>")).toBe(
    "<!doctype html><html><body>Canonical</body></html>",
  )
})

test("static Cloudflare artifact нь root болон legacy замуудыг canonical docs руу шилжүүлнэ", () => {
  expect(staticDocsEntrypointRedirects["/"]).toBe("/docs/")
  expect(staticDocsEntrypointRedirects["/mn"]).toBe("/docs/")
  expect(staticDocsEntrypointRedirects["/mn/providers"]).toBe("/docs/providers")
  expect(() => staticRedirectHtmlDocument("https://example.com")).toThrow()
  expect(() => staticRedirectHtmlDocument("//example.com")).toThrow()

  const root = mkdtempSync(join(tmpdir(), "mongolgpt-docs-entrypoints-"))
  try {
    writeStaticDocsEntrypointRedirects(root)

    const homepage = readFileSync(join(root, "index.html"), "utf8")
    const legacyHomepage = readFileSync(join(root, "mn", "index.html"), "utf8")
    const legacyProvider = readFileSync(join(root, "mn", "providers", "index.html"), "utf8")

    expect(homepage).toContain('lang="mn"')
    expect(homepage).toContain('content="0;url=/docs/"')
    expect(legacyHomepage).toContain('content="0;url=/docs/"')
    expect(legacyProvider).toContain('content="0;url=/docs/providers"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
