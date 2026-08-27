import { describe, expect, test } from "bun:test"
import { isManagedFreeModel } from "@mongolgpt/core/managed-model"

describe("managed model access policy", () => {
  test("recognizes Free Auto and every zero-cost managed tier", () => {
    expect(isManagedFreeModel({ id: "free-auto" })).toBe(true)
    expect(isManagedFreeModel({ id: "legacy-free", cost: { input: 0, output: 0 } })).toBe(true)
    expect(
      isManagedFreeModel({
        id: "tiered-free",
        cost: [
          { input: 0, output: 0 },
          { input: 0, output: 0 },
        ],
      }),
    ).toBe(true)
  })

  test("does not classify unknown or paid models as free", () => {
    expect(isManagedFreeModel({ id: "unknown" })).toBe(false)
    expect(isManagedFreeModel({ id: "paid", cost: { input: 0.1, output: 0 } })).toBe(false)
    expect(
      isManagedFreeModel({
        id: "tiered-paid",
        cost: [
          { input: 0, output: 0 },
          { input: 0, output: 1 },
        ],
      }),
    ).toBe(false)
  })
})
