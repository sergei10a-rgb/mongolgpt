import { describe, expect, test } from "bun:test"
import { authorizationRoute, pricingAuthRoute, selectedPaidPlan, workspacePlanRoute } from "./billing-route"

describe("pricing plan navigation", () => {
  test("preserves a validated paid plan through authentication and workspace selection", () => {
    expect(pricingAuthRoute("basic")).toBe("/auth?plan=basic")
    expect(authorizationRoute("pro")).toBe("/auth/authorize?continue=%2Fauth%3Fplan%3Dpro")
    expect(workspacePlanRoute(undefined, "max")).toBe("/workspace-picker?plan=max")
    expect(workspacePlanRoute("wrk_test", "basic")).toBe("/workspace/wrk_test/billing?plan=basic")
  })

  test("keeps free entry simple and rejects untrusted plan values", () => {
    expect(pricingAuthRoute("free")).toBe("/auth")
    for (const value of [undefined, "", "free", "enterprise", "pro&next=https://example.com", ["pro"]]) {
      expect(selectedPaidPlan(value)).toBeUndefined()
      expect(authorizationRoute(value)).toBe("/auth/authorize")
      expect(workspacePlanRoute("wrk_test", value)).toBe("/workspace/wrk_test")
    }
  })
})
