import { describe, expect, test } from "bun:test"
import { getRelativeTime } from "./time"

const mn = (key: string, params?: Record<string, string | number>) => {
  const count = params?.count
  const values: Record<string, string> = {
    "common.time.justNow": "Яг одоо",
    "common.time.minutesAgo.short": `${count} минутын өмнө`,
    "common.time.hoursAgo.short": `${count} цагийн өмнө`,
    "common.time.daysAgo.short": `${count} өдрийн өмнө`,
  }
  return values[key]
}

describe("getRelativeTime", () => {
  const now = Date.UTC(2026, 7, 19, 12)

  test("formats Mongolian relative time without browser locale data", () => {
    expect(getRelativeTime(now - 5_000, mn, now)).toBe("Яг одоо")
    expect(getRelativeTime(now - 2 * 60_000, mn, now)).toBe("2 минутын өмнө")
    expect(getRelativeTime(now - 3 * 60 * 60_000, mn, now)).toBe("3 цагийн өмнө")
    expect(getRelativeTime(now - 4 * 24 * 60 * 60_000, mn, now)).toBe("4 өдрийн өмнө")
  })

  test("treats future timestamps as current", () => {
    expect(getRelativeTime(now + 60_000, mn, now)).toBe("Яг одоо")
  })
})
