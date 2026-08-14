import { describe, expect, test } from "bun:test"

import { dict as en } from "./en"
import { dict as mn } from "./mn"

describe("desktop Mongolian translations", () => {
  test("covers every desktop English string", () => {
    expect(Object.keys(mn).sort()).toEqual(Object.keys(en).sort())
  })

  test("does not fall back to English and preserves interpolation", () => {
    for (const [key, english] of Object.entries(en)) {
      const mongolian = mn[key as keyof typeof mn]
      expect(mongolian).not.toBe(english)

      const placeholders = (value: string) => value.match(/{{[^}]+}}/g) ?? []
      expect(placeholders(mongolian).sort()).toEqual(placeholders(english).sort())
    }
  })
})
