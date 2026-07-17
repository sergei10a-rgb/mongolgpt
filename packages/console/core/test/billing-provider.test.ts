import { describe, expect, test } from "bun:test"
import { assertLegacyStripeEnabled, legacyStripeEnabled } from "../src/billing-provider"

describe("legacy Stripe billing guard", () => {
  test("defaults to disabled", () => {
    expect(legacyStripeEnabled({})).toBe(false)
    expect(() => assertLegacyStripeEnabled({})).toThrow("Legacy Stripe billing is disabled")
  })

  test("only accepts an explicit stripe provider", () => {
    expect(legacyStripeEnabled({ MONGOLGPT_BILLING_PROVIDER: "disabled" })).toBe(false)
    expect(legacyStripeEnabled({ MONGOLGPT_BILLING_PROVIDER: "stripe" })).toBe(true)
    expect(() => assertLegacyStripeEnabled({ MONGOLGPT_BILLING_PROVIDER: "stripe" })).not.toThrow()
  })
})
