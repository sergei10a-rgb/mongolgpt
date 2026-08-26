import { describe, expect, test } from "bun:test"
import { isDefaultTitle } from "../../src/util/session"

describe("util.session", () => {
  test("recognizes legacy and Mongolian generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Шинэ сешн - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Дэд сешн - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })
})
