import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  createSourceFile,
  forEachChild,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isReturnStatement,
  isStringLiteral,
  ScriptKind,
  ScriptTarget,
} from "typescript"

test("every admin page RPC uses the data-only boundary without changing server-only helpers", async () => {
  const root = new URL("../src/", import.meta.url)
  const files = ["component/admin-billing.tsx", "lib/admin-billing-query.ts"]
  for await (const path of new Bun.Glob("**/*.tsx").scan(fileURLToPath(new URL("routes/", root))))
    files.push(`routes/${path.replaceAll("\\", "/")}`)
  let endpoints = 0
  for (const path of files) {
    const source = await Bun.file(new URL(path, root)).text()
    const syntax = createSourceFile(path, source, ScriptTarget.Latest, true, ScriptKind.TSX)
    const visit = (node: import("typescript").Node) => {
      if (isBlock(node)) {
        const first = node.statements[0]
        if (
          first &&
          isExpressionStatement(first) &&
          isStringLiteral(first.expression) &&
          first.expression.text === "use server"
        ) {
          endpoints++
          const returned = node.statements[1]
          expect(returned && isReturnStatement(returned), `${path} must return its RPC boundary`).toBe(true)
          if (!returned || !isReturnStatement(returned) || !returned.expression)
            throw new Error(`Missing RPC response: ${path}`)
          expect(isCallExpression(returned.expression), path).toBe(true)
          if (!isCallExpression(returned.expression)) throw new Error(`Missing RPC call: ${path}`)
          expect(
            isIdentifier(returned.expression.expression) && returned.expression.expression.text === "adminResponse",
            path,
          ).toBe(true)
        }
      }
      forEachChild(node, visit)
    }
    visit(syntax)
  }
  expect(endpoints).toBe(19)
  const response = await Bun.file(new URL("lib/admin-response.ts", root)).text()
  expect(response).not.toContain("X-Revalidate")
  expect(response).not.toContain("X-Single-Flight")
})

test("revalidated support, plans and detail pages do not retain a stale data snapshot", async () => {
  const support = await Bun.file(new URL("../src/routes/support/[ticketID].tsx", import.meta.url)).text()
  const plans = await Bun.file(new URL("../src/routes/plans/index.tsx", import.meta.url)).text()
  const recovery = await Bun.file(new URL("../src/routes/billing/[recoveryID].tsx", import.meta.url)).text()
  const user = await Bun.file(new URL("../src/routes/users/[accountID].tsx", import.meta.url)).text()
  expect(support).toContain("const current = () => data().ticket")
  expect(support.match(/name="expectedLockVersion" value=\{current\(\)\.lock_version\}/g)?.length).toBe(3)
  expect(plans).toContain("const limits = () => data().active.limits")
  expect(plans).not.toContain("value={limits.")
  expect(recovery).toMatch(/when=\{data\(\)\.recovery\}\s+keyed/)
  expect(user).toMatch(/when=\{data\(\)\.account\}\s+keyed/)
})

test("query failures have a Mongolian recovery screen without exposing the server error", async () => {
  const app = await Bun.file(new URL("../src/app.tsx", import.meta.url)).text()
  expect(app).toContain("<ErrorBoundary")
  expect(app).toContain("Мэдээллийг ачаалж чадсангүй")
  expect(app).toContain('role="alert"')
  expect(app).toContain("window.location.reload()")
  expect(app).not.toContain("error.message")
})

test("refund controls share the cancellation form layout and focus styles", async () => {
  const css = await Bun.file(new URL("../src/app.css", import.meta.url)).text()
  for (const suffix of [
    "",
    " summary",
    " form",
    " label",
    " textarea",
    " textarea:focus",
    ' [data-component="confirmation"]',
    " button",
  ])
    expect(css).toContain(
      `[data-component="payment-cancellation-action"]${suffix},\n[data-component="payment-refund-action"]${suffix} {`,
    )
})
