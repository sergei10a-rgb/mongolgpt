import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  staticDocsEntrypointRedirects,
  staticRedirectHtmlDocument,
} from "../legacy-mn-redirects.mjs"

const root = join(import.meta.dir, "..", "dist")

await access(join(root, "docs", "index.html"))
await access(join(root, "docs", "pagefind", "pagefind.js"))
await access(join(root, "docs", "favicon-v3.ico"))
await access(join(root, "docs", "favicon-96x96-v3.png"))
await access(join(root, "docs", "apple-touch-icon-v3.png"))
await access(join(root, "docs", "social-share.png"))

const docsIndex = await readFile(join(root, "docs", "index.html"), "utf8")
const configuredOrigin = process.env.MONGOLGPT_PUBLIC_URL?.trim().replace(/\/$/, "")
const expectedOrigin = configuredOrigin
  ? canonicalOrigin(configuredOrigin)
  : extractAbsoluteUrl(docsIndex, /<link rel="canonical" href="([^"]+)"/)
const expectedReferences = [
  `<link rel="canonical" href="${expectedOrigin}/docs/"`,
  `href="/docs/favicon-v3.ico"`,
  `href="/docs/favicon-96x96-v3.png"`,
  `href="/docs/apple-touch-icon-v3.png"`,
  `content="${expectedOrigin}/docs/social-share.png"`,
]
for (const reference of expectedReferences) {
  if (!docsIndex.includes(reference)) throw new Error(`Static docs asset reference зөрүүтэй байна: ${reference}`)
}

for (const [source, target] of Object.entries(staticDocsEntrypointRedirects)) {
  const segments = source === "/" ? [] : source.slice(1).split("/")
  const artifact = await readFile(join(root, ...segments, "index.html"), "utf8")
  if (artifact !== staticRedirectHtmlDocument(target)) {
    throw new Error(`Static docs redirect artifact зөрүүтэй байна: ${source}`)
  }
}

console.log("Static docs root, legacy redirect, content, search artifact бэлэн байна.")

function extractAbsoluteUrl(source: string, pattern: RegExp) {
  const value = source.match(pattern)?.[1]
  if (!value) throw new Error("Static docs canonical URL дутуу байна.")
  return canonicalOrigin(new URL(value).origin)
}

function canonicalOrigin(value: string) {
  const url = new URL(value)
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.origin !== value) {
    throw new Error("Static docs public URL нь зөвхөн canonical HTTP(S) origin байна.")
  }
  return url.origin
}
