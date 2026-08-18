import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { marked } from "marked"

const docsRoot = join(import.meta.dir, "..", "src", "content", "docs")
const files = readdirSync(docsRoot)
  .filter((name) => name.endsWith(".mdx"))
  .sort()
const slugs = new Set(files.filter((name) => name !== "index.mdx").map((name) => basename(name, ".mdx")))

const requiredTopics = [
  "account",
  "admin",
  "billing",
  "cli",
  "deployment",
  "desktop",
  "faq",
  "install",
  "mcp-servers",
  "models",
  "plugins",
  "privacy",
  "providers",
  "skills",
  "troubleshooting",
  "web",
]

test("шаардлагатай Монгол гарын авлагууд тусдаа route-тэй байна", () => {
  for (const slug of requiredTopics) expect(slugs.has(slug), `${slug}.mdx дутуу байна`).toBeTrue()
})

test("docs-ийн дотоод Markdown холбоос canonical route руу заана", () => {
  const broken: string[] = []

  for (const file of files) {
    const source = readFileSync(join(docsRoot, file), "utf8")
    const links: string[] = []
    collectLinks(marked.lexer(source), links)
    const slug = basename(file, ".mdx")
    const route = slug === "index" ? "/docs/" : `/docs/${slug}/`

    for (const href of links) {
      if (href.startsWith("#") || href.startsWith("mailto:")) continue

      const url = new URL(href, `https://docs.mgpt.test${route}`)
      if (url.origin !== "https://docs.mgpt.test" || !url.pathname.startsWith("/docs/")) continue

      const target = url.pathname.slice("/docs/".length).split("/").filter(Boolean)[0]
      if (target && !slugs.has(target)) broken.push(`${file}: ${href}`)
    }
  }

  expect(broken).toEqual([])
})

function collectLinks(value: unknown, links: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectLinks(item, links)
    return
  }
  if (!value || typeof value !== "object") return

  const token = value as Record<string, unknown>
  if ((token.type === "link" || token.type === "image") && typeof token.href === "string") links.push(token.href)
  for (const child of Object.values(token)) collectLinks(child, links)
}
