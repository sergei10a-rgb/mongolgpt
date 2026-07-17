import { describe, expect, test } from "bun:test"
import { isAllowedNonProductionEmail } from "../src/auth-allowlist"

describe("non-production auth allowlist", () => {
  test("accepts an exact email without allowing the whole domain", () => {
    expect(isAllowedNonProductionEmail("owner@example.com", "owner@example.com")).toBe(true)
    expect(isAllowedNonProductionEmail("other@example.com", "owner@example.com")).toBe(false)
  })

  test("accepts a configured domain without suffix spoofing", () => {
    expect(isAllowedNonProductionEmail("owner@example.com", "example.com")).toBe(true)
    expect(isAllowedNonProductionEmail("owner@notexample.com", "example.com")).toBe(false)
  })

  test("defaults to deny", () => {
    expect(isAllowedNonProductionEmail("owner@example.com", undefined)).toBe(false)
    expect(isAllowedNonProductionEmail("owner@example.com", " ")).toBe(false)
  })
})
