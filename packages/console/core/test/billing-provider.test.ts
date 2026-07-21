import { describe, expect, test } from "bun:test"
import { assertLegacyStripeEnabled, legacyStripeEnabled } from "../src/billing-provider"

describe("legacy Stripe billing guard", () => {
  test("is permanently disabled", () => {
    expect(legacyStripeEnabled({})).toBe(false)
    expect(() => assertLegacyStripeEnabled({})).toThrow("Legacy Stripe billing is permanently disabled in MongolGPT")
  })

  test("cannot be re-enabled through environment configuration", () => {
    expect(legacyStripeEnabled({ MONGOLGPT_BILLING_PROVIDER: "disabled" })).toBe(false)
    expect(legacyStripeEnabled({ MONGOLGPT_BILLING_PROVIDER: "stripe" })).toBe(false)
    expect(() => assertLegacyStripeEnabled({ MONGOLGPT_BILLING_PROVIDER: "stripe" })).toThrow(
      "Legacy Stripe billing is permanently disabled in MongolGPT",
    )
  })
})
