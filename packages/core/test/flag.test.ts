import { afterEach, describe, expect, test } from "bun:test"
import { enabledByDefault } from "@mongolgpt/core/flag/flag"

const key = "MONGOLGPT_TEST_ENABLED_BY_DEFAULT"

afterEach(() => {
  delete process.env[key]
})

describe("enabledByDefault", () => {
  test("enables a first-party service when no override is configured", () => {
    delete process.env[key]
    expect(enabledByDefault(key)).toBe(true)
    expect(enabledByDefault(key, false)).toBe(false)
  })

  test("keeps an explicit opt-out and opt-in", () => {
    process.env[key] = "false"
    expect(enabledByDefault(key)).toBe(false)

    process.env[key] = "true"
    expect(enabledByDefault(key)).toBe(true)
  })
})
