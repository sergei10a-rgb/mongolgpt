import { describe, expect, test } from "bun:test"
import { sessionTitle } from "./session-title"

const t = (key: "session.title.new" | "session.title.child") =>
  ({
    "session.title.new": "Шинэ сешн",
    "session.title.child": "Дэд сешн",
  })[key]

describe("sessionTitle", () => {
  test("localizes internal default titles", () => {
    expect(sessionTitle("New session - 2026-08-19T12:00:00.000Z", t)).toBe("Шинэ сешн")
    expect(sessionTitle("Child session - 2026-08-19T12:00:00.000Z", t)).toBe("Дэд сешн")
    expect(sessionTitle("Шинэ сешн - 2026-08-19T12:00:00.000Z", t)).toBe("Шинэ сешн")
    expect(sessionTitle("Дэд сешн - 2026-08-19T12:00:00.000Z", t)).toBe("Дэд сешн")
  })

  test("preserves generated titles", () => {
    expect(sessionTitle("Нэвтрэх урсгалыг засах", t)).toBe("Нэвтрэх урсгалыг засах")
  })
})
