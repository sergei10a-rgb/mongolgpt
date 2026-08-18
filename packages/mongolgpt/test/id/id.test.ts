import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("Identifier.timestampAtOrBefore", () => {
  test("reconstructs timestamps on both sides of the 36-bit rollover", () => {
    const day = 24 * 60 * 60 * 1000
    const period = 2 ** 36
    const now = period * 26 + 4 * day
    const recent = now - 3 * day
    const old = now - 10 * day

    expect(Identifier.timestampAtOrBefore(Identifier.create("tool", "ascending", recent), now)).toBe(recent)
    expect(Identifier.timestampAtOrBefore(Identifier.create("tool", "ascending", old), now)).toBe(old)
  })
})
