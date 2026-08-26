import { describe, expect, test } from "bun:test"
import { formatDuration } from "../../src/util/format"

describe("util.format", () => {
  describe("formatDuration", () => {
    test("returns empty string for zero or negative values", () => {
      expect(formatDuration(0)).toBe("")
      expect(formatDuration(-1)).toBe("")
      expect(formatDuration(-100)).toBe("")
    })

    test("formats seconds under a minute", () => {
      expect(formatDuration(1)).toBe("1 сек")
      expect(formatDuration(30)).toBe("30 сек")
      expect(formatDuration(59)).toBe("59 сек")
    })

    test("formats minutes under an hour", () => {
      expect(formatDuration(60)).toBe("1 мин")
      expect(formatDuration(61)).toBe("1 мин 1 сек")
      expect(formatDuration(90)).toBe("1 мин 30 сек")
      expect(formatDuration(120)).toBe("2 мин")
      expect(formatDuration(330)).toBe("5 мин 30 сек")
      expect(formatDuration(3599)).toBe("59 мин 59 сек")
    })

    test("formats hours under a day", () => {
      expect(formatDuration(3600)).toBe("1 цаг")
      expect(formatDuration(3660)).toBe("1 цаг 1 мин")
      expect(formatDuration(7200)).toBe("2 цаг")
      expect(formatDuration(8100)).toBe("2 цаг 15 мин")
      expect(formatDuration(86399)).toBe("23 цаг 59 мин")
    })

    test("formats days under a week", () => {
      expect(formatDuration(86400)).toBe("~1 хоног")
      expect(formatDuration(172800)).toBe("~2 хоног")
      expect(formatDuration(259200)).toBe("~3 хоног")
      expect(formatDuration(604799)).toBe("~6 хоног")
    })

    test("formats weeks", () => {
      expect(formatDuration(604800)).toBe("~1 долоо хоног")
      expect(formatDuration(1209600)).toBe("~2 долоо хоног")
      expect(formatDuration(1609200)).toBe("~2 долоо хоног")
    })

    test("handles boundary values correctly", () => {
      expect(formatDuration(59)).toBe("59 сек")
      expect(formatDuration(60)).toBe("1 мин")
      expect(formatDuration(3599)).toBe("59 мин 59 сек")
      expect(formatDuration(3600)).toBe("1 цаг")
      expect(formatDuration(86399)).toBe("23 цаг 59 мин")
      expect(formatDuration(86400)).toBe("~1 хоног")
      expect(formatDuration(604799)).toBe("~6 хоног")
      expect(formatDuration(604800)).toBe("~1 долоо хоног")
    })
  })
})
