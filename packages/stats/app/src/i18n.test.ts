import { describe, expect, test } from "bun:test"
import { dict, en, type Key } from "./i18n"

const intentionalEnglish = new Set<Key>([
  "header.github",
  "footer.youtube",
  "footer.copyright",
  "model.pdf",
])

describe("Stats-ийн Монгол хэлний каталог", () => {
  test("Монгол каталог Англи каталогийн бүх түлхүүрийг бүрэн агуулна", () => {
    const mongolian = dict("mn")
    const englishKeys = Object.keys(en).sort()
    const mongolianKeys = Object.keys(mongolian).sort()

    expect(mongolianKeys).toEqual(englishKeys)
    for (const key of englishKeys as Key[]) {
      expect(mongolian[key].trim().length).toBeGreaterThan(0)
    }
  })

  test("Монгол каталог санамсаргүйгээр Англи fallback ашиглахгүй", () => {
    const mongolian = dict("mn")

    for (const key of Object.keys(en) as Key[]) {
      if (intentionalEnglish.has(key)) continue
      expect(mongolian[key]).not.toBe(en[key])
    }
  })

  test("Хоосон төлвийн тайлбар нь зөвхөн огнооны хүрээг заана", () => {
    const mongolian = dict("mn")

    expect(en["home.noUsageDescription"]).toBe("No model rows matched this date range.")
    expect(en["home.noLeaderboardDescription"]).toBe("No model rows matched this date range.")
    expect(mongolian["home.noUsageDescription"]).toBe("Энэ хугацаанд тохирох загварын мөр олдсонгүй.")
    expect(mongolian["home.noLeaderboardDescription"]).toBe("Энэ хугацаанд тохирох загварын мөр олдсонгүй.")
  })
})
