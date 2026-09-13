import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import ts from "typescript"

const files = [
  ["component/header.tsx", 4],
  ["routes/index.tsx", 5],
  ["routes/download/index.tsx", 1],
  ["routes/pricing/index.tsx", 2],
  ["routes/support/index.tsx", 1],
] as const

describe("server-only auth navigation", () => {
  for (const [file, expected] of files) {
    test(`${file} sends auth links to the server instead of the SPA 404`, async () => {
      const text = await Bun.file(resolve(import.meta.dir, "../src", file)).text()
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const links: ts.JsxOpeningElement[] = []
      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "A") {
          const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
          const href = attrs.find((attr) => attr.name.getText(source) === "href")?.initializer?.getText(source)
          const rel = attrs.find((attr) => attr.name.getText(source) === "rel")?.initializer?.getText(source)
          if (href?.includes('"/auth"') || href?.includes("pricingAuthRoute")) {
            expect(rel).toBe('"external"')
            links.push(node)
          } else if (rel?.includes('"/auth"')) {
            const variable = href?.match(/language\.route\((\w+)\.href\)/)?.[1]
            expect(variable).toBeDefined()
            expect(rel).toBe(`{${variable}.href === "/auth" ? "external" : undefined}`)
            links.push(node)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      // Solid Router skips rel=external for clicks and preloads, even on this origin.
      expect(links).toHaveLength(expected)
    })
  }
})
