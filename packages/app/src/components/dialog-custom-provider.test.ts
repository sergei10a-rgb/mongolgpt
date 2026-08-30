import { describe, expect, test } from "bun:test"
import {
  CUSTOM_PROVIDER_PRESETS,
  validateCustomProvider,
  validateCustomProviderBaseUrl,
} from "./dialog-custom-provider-form"

const t = (key: string) => key

describe("validateCustomProvider", () => {
  test.each([
    "https://api.example.com/v1",
    "https://api.example.com",
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8000/v1",
  ])("accepts allowed base URL %s", (baseURL) => {
    expect(validateCustomProviderBaseUrl(baseURL)).toBe(true)
  })

  test.each([
    "http://api.example.com/v1",
    "http://localhost.example.com/v1",
    "http://192.168.1.10:8000/v1",
    "http://10.0.0.5/v1",
    "http://127.0.0.2:11434/v1",
    "//localhost:11434/v1",
    "file:///tmp/model",
    "not a url",
    "https://user:secret@api.example.com/v1",
    "http://user:secret@127.0.0.1:11434/v1",
  ])("rejects unsafe base URL %s", (baseURL) => {
    expect(validateCustomProviderBaseUrl(baseURL)).toBe(false)
  })

  test.each([
    ["ollama", "http://127.0.0.1:11434/v1"],
    ["lm-studio", "http://127.0.0.1:1234/v1"],
  ] as const)("builds a local %s preset without an API key", (id, baseURL) => {
    const preset = CUSTOM_PROVIDER_PRESETS[id]
    const result = validateCustomProvider({
      form: {
        ...preset,
        apiKey: "",
        models: [{ row: "m0", id: "local-model", name: "Local Model", err: {} }],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toMatchObject({
      providerID: preset.providerID,
      name: preset.name,
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL },
        models: { "local-model": { name: "Local Model" } },
      },
    })
  })

  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [{ row: "m0", id: " model-a ", name: " Model A ", err: {} }],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toEqual({
      providerID: "custom-provider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })
  })

  test("flags duplicate rows and allows reconnecting disabled providers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", err: {} },
        ],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: ["custom-provider"],
      existingProviderIDs: new Set(["custom-provider"]),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBeUndefined()
    expect(result.models[1]).toEqual({
      id: "provider.custom.error.duplicate",
      name: undefined,
    })
    expect(result.headers[1]).toEqual({
      key: "provider.custom.error.duplicate",
      value: undefined,
    })
  })

  test.each([
    "http://api.example.com/v1",
    "http://192.168.1.10:8000/v1",
    "not a url",
    "https://user:secret@api.example.com/v1",
  ])("reports an error for unsafe custom provider URL %s", (baseURL) => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL,
        apiKey: "secret",
        models: [{ row: "m0", id: "model-a", name: "Model A", err: {} }],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.baseURL).toBe("provider.custom.error.baseURL.format")
  })
})
