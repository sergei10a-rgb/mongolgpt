import { expect, test } from "bun:test"
import type { Model } from "@mongolgpt/sdk/v2"
import { isFreeModel } from "./free-model"

const model = {
  id: "new-native-model",
  providerID: "mongolgpt",
  status: "active",
  api: { id: "new-native-model", url: "https://opencode.ai/zen/v1", npm: "@ai-sdk/openai-compatible" },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
} satisfies Pick<Model, "id" | "providerID" | "status" | "api" | "cost">

test("labels dynamically discovered native zero-cost models as free", () => {
  expect(isFreeModel(model)).toBe(true)
  expect(isFreeModel({ ...model, id: "another-free", api: { ...model.api, id: "another-free" } })).toBe(true)
  expect(
    isFreeModel({
      ...model,
      cost: {
        ...model.cost,
        experimentalOver200K: model.cost,
        tiers: [{ ...model.cost, tier: { type: "context", size: 200_000 } }],
      },
    }),
  ).toBe(true)
})

test("never labels synthetic or own-key routes as free", () => {
  for (const id of ["free-auto", "openrouter-byok", "nvidia-nim-byok"]) {
    expect(isFreeModel({ ...model, id, api: { ...model.api, id } })).toBe(false)
  }
  expect(isFreeModel({ ...model, providerID: "openrouter" })).toBe(false)
  expect(isFreeModel({ ...model, api: { ...model.api, url: "https://dev.mgpt.mn/gateway/v1" } })).toBe(false)
})

test("does not infer free usage from missing prices or free input alone", () => {
  expect(isFreeModel({ ...model, cost: undefined })).toBe(false)
  for (const cost of [
    { ...model.cost, input: 1 },
    { ...model.cost, output: 1 },
    { ...model.cost, cache: { read: 1, write: 0 } },
    { ...model.cost, cache: { read: 0, write: 1 } },
    { ...model.cost, experimentalOver200K: { ...model.cost, output: 1 } },
    { ...model.cost, tiers: [{ ...model.cost, output: 1, tier: { type: "context" as const, size: 200_000 } }] },
  ])
    expect(isFreeModel({ ...model, cost })).toBe(false)
})

test("rejects inactive models and mismatched or unverified upstream routes", () => {
  for (const status of ["alpha", "deprecated"] as const) expect(isFreeModel({ ...model, status })).toBe(false)
  expect(isFreeModel({ ...model, api: { ...model.api, id: "different" } })).toBe(false)
  for (const url of [
    "invalid",
    "http://opencode.ai/zen/v1",
    "https://opencode.ai.example/zen/v1",
    "https://opencode.ai/not-zen",
  ])
    expect(isFreeModel({ ...model, api: { ...model.api, url } })).toBe(false)
})
