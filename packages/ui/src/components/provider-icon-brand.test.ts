import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const asset = readFileSync(new URL("../assets/icons/provider/mongolgpt.svg", import.meta.url), "utf8")
const sprite = readFileSync(new URL("./provider-icons/sprite.svg", import.meta.url), "utf8")

describe("MongolGPT provider icon", () => {
  test("keeps the geometric M mark in the source asset and generated sprite", () => {
    const symbol = sprite.match(/<symbol\b[^>]*\bid="mongolgpt"[^>]*>([\s\S]*?)<\/symbol>/)?.[1]

    expect(symbol).toBeDefined()
    for (const source of [asset, symbol ?? ""]) {
      expect(source).toContain('fill="#151111"')
      expect(source).toContain('d="M6.8 16.8V7.2L12 12.2L17.2 7.2V16.8"')
      expect(source).toContain('stroke="#F7F7F3"')
      expect(source).toContain('stroke-width="2.35"')
      expect(source).not.toContain('d="M8.35 7.88L13.78 12L8.35 16.13"')
      expect(source).not.toContain('stroke="#26E6F2"')
      expect(source).not.toContain('fill="#37F28B"')
      expect(source).not.toContain("M8.40005 17.4H19.2001")
      expect(source).not.toContain("linearGradient")
    }
  })
})
