import { describe, expect, test } from "bun:test"

const files = ["mongolgpt.ts", "openai.ts"] as const

describe("provider OAuth-ийн Монгол fallback мэдээлэл", () => {
  for (const file of files) {
    test(file, async () => {
      const source = await Bun.file(new URL(`../src/plugin/provider/${file}`, import.meta.url)).text()
      expect(source).toContain('end("Олдсонгүй")')
      expect(source).not.toContain('end("Not found")')
    })
  }
})
