import { expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  legacyMongolianDocRedirects,
  legacyMongolianDocSlugs,
  normalizeStaticRedirectHtmlDocument,
} from "../legacy-mn-redirects.mjs"

const docsRoot = join(import.meta.dir, "..")

test("хуучин Монгол docs source duplicate хадгалагдаагүй байна", () => {
  const legacyDirectory = join(docsRoot, "src", "content", "docs", "mn")
  expect(existsSync(legacyDirectory) ? readdirSync(legacyDirectory) : []).toHaveLength(0)
})

test("хуучин Монгол docs замууд root docs руу redirect-тэй байна", () => {
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
