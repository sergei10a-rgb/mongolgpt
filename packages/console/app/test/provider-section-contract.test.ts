import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("provider section contract", () => {
  test("offers the full hosted BYOK provider set with canonical ids", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/routes/workspace/[id]/provider-section.tsx"), "utf8")

    expect(source).toContain('{ name: "OpenAI", key: "openai", prefix: "sk-" }')
    expect(source).toContain('{ name: "Anthropic", key: "anthropic", prefix: "sk-ant-" }')
    expect(source).toContain('{ name: "Google Gemini", key: "google", prefix: "AIza" }')
    expect(source).toContain('{ name: "OpenRouter", key: "openrouter", prefix: "sk-or-v1-" }')
    expect(source).toContain('{ name: "NVIDIA NIM", key: "nvidia-nim", prefix: "nvapi-" }')
  })

  test("reuses the core provider schemas and keeps the prefix placeholder explanatory", () => {
    const view = readFileSync(resolve(import.meta.dir, "../src/routes/workspace/[id]/provider-section.tsx"), "utf8")
    const mn = readFileSync(resolve(import.meta.dir, "../src/i18n/mn.ts"), "utf8")
    const en = readFileSync(resolve(import.meta.dir, "../src/i18n/en.ts"), "utf8")

    expect(view).toContain("Provider.remove.schema.safeParse")
    expect(view).toContain("Provider.create.schema.safeParse")
    expect(view).toContain('i18n.t("workspace.providers.placeholder"')
    expect(mn).toContain('Жишээ: {{prefix}}...')
    expect(en).toContain('for example {{prefix}}...')
  })
})
