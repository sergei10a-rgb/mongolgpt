import { describe, expect, test } from "bun:test"
import { AccountTransportError } from "../../src/account/schema"
import { FormatError } from "../../src/cli/error"
import { UI } from "../../src/cli/ui"

describe("cli.error", () => {
  test("formats legacy and tagged config errors the same way", () => {
    const cases = [
      {
        tag: "ConfigJsonError",
        data: { path: "/tmp/mongolgpt.jsonc", message: "Unexpected token" },
        expected: "/tmp/mongolgpt.jsonc дахь config файл хүчинтэй JSON(C) биш: Unexpected token",
      },
      {
        tag: "ConfigDirectoryTypoError",
        data: { path: "/tmp/mongolgpt.jsonc", dir: ".mongolgpt", suggestion: "mongolgpt" },
        expected:
          '/tmp/mongolgpt.jsonc дахь ".mongolgpt" хавтас хүчинтэй биш. Хавтсыг "mongolgpt" гэж нэрлэ, эсвэл устгана уу. Энэ нь түгээмэл typo.',
      },
      {
        tag: "ConfigFrontmatterError",
        data: { path: "/tmp/AGENTS.md", message: "failed frontmatter" },
        expected: "failed frontmatter",
      },
      {
        tag: "ConfigInvalidError",
        data: {
          path: "/tmp/mongolgpt.jsonc",
          message: "schema mismatch",
          issues: [{ message: "Expected string", path: ["provider", "id"] }],
        },
        expected: "Тохиргоо хүчинтэй биш (/tmp/mongolgpt.jsonc): schema mismatch\n↳ Expected string provider.id",
      },
    ]

    for (const item of cases) {
      expect(FormatError({ name: item.tag, data: item.data })).toBe(item.expected)
      expect(FormatError({ _tag: item.tag, ...item.data })).toBe(item.expected)
    }
  })

  test("preserves multiline JSONC diagnostics for tagged config errors", () => {
    const data = {
      path: "/tmp/mongolgpt.jsonc",
      message:
        '\n--- JSONC Input ---\n{\n  "model": \n}\n--- Errors ---\nValueExpected at line 3, column 1\n   Line 3: }\n          ^\n--- End ---',
    }
    const expected = `${data.path} дахь config файл хүчинтэй JSON(C) биш: ${data.message}`

    expect(FormatError({ name: "ConfigJsonError", data })).toBe(expected)
    expect(FormatError({ _tag: "ConfigJsonError", ...data })).toBe(expected)
  })

  test("formats account transport errors clearly", () => {
    const error = new AccountTransportError({
      method: "POST",
      url: "https://example.invalid/auth/device/code",
    })

    const formatted = FormatError(error)

    expect(formatted).toContain("Could not reach POST https://example.invalid/auth/device/code.")
    expect(formatted).toContain("This failed before the server returned an HTTP response.")
    expect(formatted).toContain("Check your network, proxy, or VPN configuration and try again.")
  })

  test("formats legacy and tagged provider model errors the same way", () => {
    const data = {
      providerID: "anthropic",
      modelID: "claude-sonet-4",
      suggestions: ["claude-sonnet-4"],
    }
    const expected = [
      "Model олдсонгүй: anthropic/claude-sonet-4",
      "Та үүнийг хэлсэн үү: claude-sonnet-4",
      "Боломжит model-уудыг харахын тулд `mongolgpt models` ажиллуулна уу",
      "Эсвэл config (mongolgpt.json) доторх provider/model нэрээ шалгана уу",
    ].join("\n")

    expect(FormatError({ name: "ProviderModelNotFoundError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderModelNotFoundError", ...data })).toBe(expected)
  })

  test("formats legacy and tagged provider init errors the same way", () => {
    const data = { providerID: "anthropic" }
    const expected = '"anthropic" provider-ийг эхлүүлж чадсангүй. Credential болон тохиргоогоо шалгана уу.'

    expect(FormatError({ name: "ProviderInitError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderInitError", ...data })).toBe(expected)
  })

  test("formats cancelled UI errors as empty output", () => {
    expect(FormatError(new UI.CancelledError())).toBe("")
  })
})
