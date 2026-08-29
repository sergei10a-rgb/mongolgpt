import { access, readFile } from "node:fs/promises"
import { join, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
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

await verifySearchIndex()

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

async function verifySearchIndex() {
  const searchRoot = join(root, "docs", "pagefind")
  const nativeFetch = globalThis.fetch
  const localFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (!url.startsWith("file:")) return nativeFetch(input, init)
      return new Response(await readFile(fileURLToPath(url)), { status: 200 })
    },
    { preconnect: nativeFetch.preconnect },
  )
  globalThis.fetch = localFetch

  type SearchResult = { data: () => Promise<{ url: string }> }
  type SearchIndex = {
    init: () => Promise<void>
    search: (query: string) => Promise<{ results: SearchResult[] }>
    destroy: () => Promise<void>
  }
  type PagefindModule = {
    createInstance: (options: {
      basePath: string
      baseUrl: string
      language: string
      noWorker: boolean
    }) => SearchIndex
  }

  let index: SearchIndex | undefined
  try {
    const pagefind = (await import(pathToFileURL(join(searchRoot, "pagefind.js")).href)) as PagefindModule
    index = pagefind.createInstance({
      basePath: pathToFileURL(searchRoot + sep).href,
      baseUrl: "/docs",
      language: "mn",
      noWorker: true,
    })
    await index.init()

    for (const [query, expectedPath] of [
      ["Free Auto", "/docs/account/"],
      ["алдаа оношлох", "/docs/troubleshooting/"],
      ["MCP серверүүд", "/docs/mcp-servers/"],
      ["Аюулгүй ашиглалт", "/docs/security/"],
      ["Буцаах төлөвлөгөө", "/docs/release-upgrade/"],
      ["Ослын хариу арга хэмжээ", "/docs/incident-response/"],
      ["Claude Codex Goose", "/docs/ecosystem/"],
    ] as const) {
      const result = await index.search(query)
      const documents = await Promise.all(result.results.slice(0, 20).map((item) => item.data()))
      if (!documents.some((item) => item.url === expectedPath)) {
        throw new Error(`Static docs хайлт зөв хуудас буцаасангүй: ${query} -> ${expectedPath}`)
      }
    }
  } finally {
    await index?.destroy()
    globalThis.fetch = nativeFetch
  }
}
