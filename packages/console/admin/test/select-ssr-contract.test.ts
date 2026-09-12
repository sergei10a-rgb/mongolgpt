import { expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  createSourceFile,
  forEachChild,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  ScriptKind,
  ScriptTarget,
} from "typescript"

test("native options encode the selected server state before hydration", async () => {
  const root = resolve(import.meta.dir, "../src")
  let options = 0
  let consumers = 0
  for await (const path of new Bun.Glob("{routes,component}/**/*.tsx").scan(root)) {
    const source = await Bun.file(resolve(root, path)).text()
    const syntax = createSourceFile(path, source, ScriptTarget.Latest, true, ScriptKind.TSX)
    const visit = (node: import("typescript").Node) => {
      if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) {
        const attributes = node.attributes.properties.filter(isJsxAttribute)
        const tag = node.tagName.getText(syntax)
        if (tag === "option") {
          options++
          const selected = attributes.find((attribute) => attribute.name.getText(syntax) === "selected")
          expect(
            selected?.initializer && isJsxExpression(selected.initializer),
            `${path}: option requires SSR selection`,
          ).toBeTruthy()
          if (!selected?.initializer || !isJsxExpression(selected.initializer)) throw new Error(path)
          const expression = selected.initializer.expression?.getText(syntax)
          expect(expression, `${path}: selection must follow data, not a constant`).toMatch(/===|^!current\(\)/)
          const value = attributes.find((attribute) => attribute.name.getText(syntax) === "value")
          const key = value?.initializer?.getText(syntax).replace(/["{}]/g, "")
          if (key !== "__unassigned") expect(expression, path).toContain(key!)
        }
        if (["RoleOptions", "StatusOptions", "PriorityOptions", "AssignmentOptions"].includes(tag)) {
          consumers++
          expect(
            attributes.some((attribute) => attribute.name.getText(syntax) === "value"),
            `${path}: ${tag}`,
          ).toBe(true)
        }
      }
      forEachChild(node, visit)
    }
    visit(syntax)
  }
  expect(options).toBeGreaterThanOrEqual(40)
  expect(consumers).toBe(7)
})

test("billing reports remain reactive when filters or actions refresh their queries", async () => {
  const source = await Bun.file(resolve(import.meta.dir, "../src/routes/billing/index.tsx")).text()
  expect(source).toContain("data={data()[0]} recoveries={data()[1]}")
  expect(source).not.toContain("const [report, recoveries] = data()")
})

test("support and operator edits retain saved permissions and assignment in their options", async () => {
  const support = await Bun.file(resolve(import.meta.dir, "../src/routes/support/[ticketID].tsx")).text()
  const operators = await Bun.file(resolve(import.meta.dir, "../src/routes/admins/index.tsx")).text()
  expect(support).toContain("<StatusOptions current={current().status} value={current().status}")
  expect(support).toContain("<PriorityOptions value={current().priority}")
  expect(support).toContain("selected={current().assigned_admin_id === admin.id}")
  expect(operators).toContain("<RoleOptions value={operator.role}")
  expect(operators).toContain('<RoleOptions value="administrator"')
})
