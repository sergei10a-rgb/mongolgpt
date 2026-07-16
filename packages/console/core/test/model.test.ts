import { describe, expect, test } from "bun:test"
import { ZenData } from "../src/model"

const model = {
  name: "MongolGPT Free Auto",
  cost: { input: 0, output: 0 },
  allowAnonymous: false,
  freeForAuthenticated: true,
  fallbackProvider: "secondary",
  rateLimit: 20,
  freeWeeklyTokenLimit: 100_000,
  freeMaxTokensPerRequest: 32_000,
  providers: [
    { id: "primary", model: "primary-model" },
    { id: "secondary", model: "secondary-model" },
  ],
}

const config = (freeAuto: Record<string, unknown>) => ({
  zenModels: { "free-auto": freeAuto },
  liteModels: {},
  providers: {
    primary: { api: "https://primary.example/v1", apiKey: "primary-key" },
    secondary: { api: "https://secondary.example/v1", apiKey: "secondary-key" },
  },
})
const validate = (input: unknown) => ZenData.validate.schema.parse(input)

describe("MongolGPT Free Auto model contract", () => {
  test("accepts an account-only production route with a fallback", () => {
    expect(() => validate(config(model))).not.toThrow()
  })

  test("rejects anonymous or trial-backed Free Auto routes", () => {
    expect(() => validate(config({ ...model, allowAnonymous: true }))).toThrow()
    expect(() => validate(config({ ...model, trialProvider: "primary" }))).toThrow()
  })

  test("requires authenticated-free billing and a configured fallback", () => {
    expect(() => validate(config({ ...model, freeForAuthenticated: false }))).toThrow()
    expect(() => validate(config({ ...model, fallbackProvider: undefined }))).toThrow()
    expect(() => validate(config({ ...model, fallbackProvider: "missing" }))).toThrow()
  })

  test("requires a weekly token quota", () => {
    expect(() => validate(config({ ...model, freeWeeklyTokenLimit: undefined }))).toThrow()
    expect(() => validate(config({ ...model, freeWeeklyTokenLimit: 0 }))).toThrow()
  })

  test("requires a bounded per-request billable token total", () => {
    expect(() => validate(config({ ...model, freeMaxTokensPerRequest: undefined }))).toThrow()
    expect(() => validate(config({ ...model, freeMaxTokensPerRequest: 0 }))).toThrow()
    expect(() => validate(config({ ...model, freeMaxTokensPerRequest: 100_001 }))).toThrow()
  })
})
