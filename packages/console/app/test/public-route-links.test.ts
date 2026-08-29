import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = (path: string) => readFileSync(resolve(import.meta.dir, "..", "src", path), "utf8")

describe("public route link contract", () => {
  test("pricing page keeps plan CTAs locale-aware", () => {
    const pricing = source("routes/pricing/index.tsx")
    expect(pricing).toContain('href={language.route("/auth")}')
    expect(pricing).not.toContain('href="/auth"')
  })

  test("support page quick links point to live docs and localized auth", () => {
    const support = source("routes/support/index.tsx")
    expect(support).toContain('language.route("/docs/install/")')
    expect(support).toContain('language.route("/docs/providers/")')
    expect(support).toContain('language.route("/docs/troubleshooting/")')
    expect(support).toContain('href={language.route("/auth")}')
    expect(support).toContain("бүртгэл үүсгэнэ үү")
    expect(support).toContain("Нэвтэрч эсвэл бүртгүүлээд хүсэлт илгээх")
    expect(support).not.toContain('"/docs/getting-started/"')
  })
})
