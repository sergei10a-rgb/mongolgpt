import { describe, expect, test } from "bun:test"
import {
  isManagedFreeModel,
  isOpenCodePublicApi,
  isOpenCodePublicFreeModel,
} from "@mongolgpt/core/managed-model"

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

describe("OpenCode public free model routing", () => {
  test("accepts only the trusted HTTPS Zen route", () => {
    expect(isOpenCodePublicApi("https://opencode.ai/zen/v1")).toBe(true)
    expect(isOpenCodePublicApi("https://opencode.ai/zen/go/v1")).toBe(true)
    expect(isOpenCodePublicApi("http://opencode.ai/zen/v1")).toBe(false)
    expect(isOpenCodePublicApi("https://example.test/zen/v1")).toBe(false)
    expect(isOpenCodePublicApi("not-a-url")).toBe(false)
  })

  test("requires the MongolGPT provider, a free direct model, and excludes Free Auto", () => {
    const direct = {
      id: "big-pickle",
      providerID: "mongolgpt",
      api: { url: "https://opencode.ai/zen/v1" },
      cost: { input: 0, output: 0 },
    }
    expect(isOpenCodePublicFreeModel(direct)).toBe(true)
    expect(isOpenCodePublicFreeModel({ ...direct, id: "free-auto" })).toBe(false)
    expect(isOpenCodePublicFreeModel({ ...direct, providerID: "other" })).toBe(false)
    expect(isOpenCodePublicFreeModel({ ...direct, cost: { input: 1, output: 0 } })).toBe(false)
  })
})
