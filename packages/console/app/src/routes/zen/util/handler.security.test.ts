import { describe, expect, test } from "bun:test"
import ts from "typescript"

const path = `${import.meta.dir}/handler.ts`
const source = await Bun.file(path).text()
const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

function loggerCalls() {
  const result: Array<{ method: string; payload: string }> = []

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "logger"
    ) {
      result.push({
        method: node.expression.name.text,
        payload: node.arguments.map((argument) => argument.getText(sourceFile)).join(", "),
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return result
}

describe("Zen handler telemetry security", () => {
  test("logs metadata only and never content-bearing values", () => {
    const calls = loggerCalls()
    expect(calls.length).toBeGreaterThan(0)

    const forbidden = [
      /\breqBody\b/,
      /\bbody\b/,
      /\bjson\b/,
      /\bpart\b/,
      /\breqUrl\b/,
      /\bstatusText\b/,
      /\berror\s*\.\s*(?:message|cause)\b/,
      /\bJSON\s*\.\s*stringify\b/,
      /\b(?:api_key|user_id)\s*:/,
      /\b(?:rawZenApiKey|zenApiKey|data\.apiKey|data\.user\.id)\b/,
      /["'`](?:error\.response|error\.message|error\.cause2?|request_body|response_body|stream_part)["'`]/,
    ]

    for (const call of calls) {
      expect(call.method).toBe("metric")
      for (const pattern of forbidden) expect(call.payload).not.toMatch(pattern)
    }
  })

  test("records UTF-8 byte lengths instead of request or response content", () => {
    expect(source).toContain("new TextEncoder().encode(value).byteLength")
    expect(source).toContain("const requestLength = contentByteLength(reqBody)")
    expect(source).toContain("const responseLength = contentByteLength(body)")
    expect(source).toMatch(/request_length:\s*requestLength/)
    expect(source).toMatch(/response_length:\s*responseLength/)
    expect(source).toContain("responseLength += value.length")
  })

  test("derives console links from configured product URL", () => {
    expect(source).toContain('import { config } from "~/config"')
    expect(source).toContain("config.baseUrl")
    expect(source).not.toMatch(/https?:\/\//)
  })

  test("never selects a deleted BYOK credential", () => {
    expect(source).toMatch(
      /eq\(ProviderTable\.provider,\s*modelInfo\.byokProvider\),\s*isNull\(ProviderTable\.timeDeleted\)/,
    )
  })
})
