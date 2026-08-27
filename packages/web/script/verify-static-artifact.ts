import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  staticDocsEntrypointRedirects,
  staticRedirectHtmlDocument,
} from "../legacy-mn-redirects.mjs"

const root = join(import.meta.dir, "..", "dist")

await access(join(root, "docs", "index.html"))
await access(join(root, "docs", "pagefind", "pagefind.js"))

for (const [source, target] of Object.entries(staticDocsEntrypointRedirects)) {
  const segments = source === "/" ? [] : source.slice(1).split("/")
  const artifact = await readFile(join(root, ...segments, "index.html"), "utf8")
  if (artifact !== staticRedirectHtmlDocument(target)) {
    throw new Error(`Static docs redirect artifact зөрүүтэй байна: ${source}`)
  }
}

console.log("Static docs root, legacy redirect, content, search artifact бэлэн байна.")
