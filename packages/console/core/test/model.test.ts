import { describe, expect, test } from "bun:test"
import { GatewayCatalog, GatewayConfigurationError, normalizeGatewayModelRoutes } from "../src/model"
import { isProviderAllowedForStage, modelConfigurationStageIssues } from "../src/model-config"

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
    { id: "primary", model: "primary-model", priority: 0 },
    { id: "secondary", model: "secondary-model", priority: 1 },
  ],
}

const config = (freeAuto: Record<string, unknown>) => ({
  models: { "free-auto": freeAuto },
  lightweightModels: {},
  providers: {
    primary: {
      api: "https://opencode.ai/zen/v1",
      apiKey: "public",
      providerKind: "mongolgpt-base-free",
      usageMode: "managed",
    },
    secondary: {
      api: "https://secondary.example/v1",
      apiKey: "secondary-key",
      providerKind: "nvidia-nim",
      usageMode: "managed",
    },
  },
})
const validate = (input: unknown) => GatewayCatalog.validate.schema.parse(input)

describe("MongolGPT Free Auto model contract", () => {
  test("classifies missing, malformed, and unsafe gateway configuration without exposing details", () => {
    for (const canonical of ["", "{not-json", JSON.stringify({ models: {} })]) {
      expect(() => GatewayCatalog.parseConfiguration({ canonical, stage: "dev" })).toThrow(GatewayConfigurationError)
    }

    expect(() =>
      GatewayCatalog.parseConfiguration({
        canonical: JSON.stringify(config(model)),
        stage: "production",
      }),
    ).toThrow(GatewayConfigurationError)
  })

  test("allows only explicitly approved managed providers or account-owned BYOK in production", () => {
    const unapproved = { productionUseApproved: false }
    const approved = { productionUseApproved: true }

    expect(isProviderAllowedForStage(unapproved, "production")).toBe(false)
    expect(isProviderAllowedForStage(approved, "production")).toBe(true)
    expect(isProviderAllowedForStage({ usageMode: "byok" }, "production")).toBe(true)
  })

  test("keeps non-production provider configuration usable", () => {
    expect(isProviderAllowedForStage({}, "dev")).toBe(true)
    expect(isProviderAllowedForStage({ productionUseApproved: false }, "test")).toBe(true)
  })

  test("does not allow an unapproved fallback to bypass production policy", () => {
    const providers = {
      primary: { productionUseApproved: true },
      fallback: { productionUseApproved: false },
    }

    expect(isProviderAllowedForStage(providers.primary, "production")).toBe(true)
    expect(isProviderAllowedForStage(providers.fallback, "production")).toBe(false)
  })

  test("requires an approved managed OpenCode free primary and NVIDIA NIM fallback in production", () => {
    const valid = validate({
      ...config(model),
      providers: {
        primary: {
          api: "https://opencode.ai/zen/v1",
          apiKey: "public",
          providerKind: "mongolgpt-base-free",
          usageMode: "managed",
          productionUseApproved: true,
        },
        secondary: {
          api: "https://integrate.api.nvidia.com/v1",
          apiKey: "secondary-key",
          providerKind: "nvidia-nim",
          usageMode: "managed",
          productionUseApproved: true,
        },
      },
    })

    expect(modelConfigurationStageIssues(valid, "production")).toEqual([])
    expect(modelConfigurationStageIssues(valid, "dev")).toEqual([])

    const withByok = structuredClone(valid)
    withByok.lightweightModels.assistant = {
      name: "BYOK Assistant",
      cost: { input: 0, output: 0 },
      byokProvider: "openai",
      maxTokensPerRequest: 32_000,
      providers: [{ id: "openai", model: "gpt-5-mini" }],
    }
    withByok.providers.openai = {
      api: "https://api.openai.com/v1",
      apiKey: "server-fallback-key",
      providerKind: "openai-compatible",
      usageMode: "byok",
    }
    expect(modelConfigurationStageIssues(withByok, "production")).toEqual([])

    const unsafe = structuredClone(valid)
    unsafe.providers.primary.productionUseApproved = false
    unsafe.providers.primary.usageMode = "trial"
    unsafe.providers.primary.providerKind = "openrouter"
    unsafe.providers.secondary.providerKind = "mongolgpt-base-free"

    expect(modelConfigurationStageIssues(unsafe, "production")).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"primary" үйлчилгээ үзүүлэгчийг productionUseApproved=true гэж тохируулах ёстой'),
        expect.stringContaining('"primary" үйлчилгээ үзүүлэгчийг usageMode=managed гэж тохируулах ёстой'),
        expect.stringContaining("MongolGPT үнэгүй чиглэлийг fallbackProvider болгож болохгүй"),
        expect.stringContaining("хамгийн түрүүнд ашиглах чиглэл providerKind=mongolgpt-base-free байх ёстой"),
      ]),
    )
  })

  test("accepts an account-only production route with a fallback", () => {
    expect(() => validate(config(model))).not.toThrow()
  })

  test("requires every hosted BYOK model to use its matching BYOK-only route", () => {
    const byok = {
      ...config(model),
      lightweightModels: {
        assistant: {
          name: "OpenRouter BYOK",
          cost: { input: 0, output: 0 },
          byokProvider: "openrouter",
          maxTokensPerRequest: 8_192,
          providers: [{ id: "openrouter", model: "openrouter/free" }],
        },
      },
      providers: {
        ...config(model).providers,
        openrouter: {
          api: "https://openrouter.ai/api/v1",
          apiKey: "byok-required",
          providerKind: "openrouter",
          usageMode: "byok",
        },
      },
    }

    expect(() => validate(byok)).not.toThrow()
    expect(() =>
      validate({
        ...byok,
        providers: { ...byok.providers, openrouter: { ...byok.providers.openrouter, usageMode: "managed" } },
      }),
    ).toThrow(/usageMode=byok/)
    expect(() =>
      validate({
        ...byok,
        lightweightModels: {
          assistant: { ...byok.lightweightModels.assistant, providers: [{ id: "primary", model: "primary-model" }] },
        },
      }),
    ).toThrow(/идэвхтэй чиглэлийг/)
  })

  test("rejects the retired model-list keys", () => {
    const current = config(model)
    expect(() =>
      validate({
        zenModels: current.models,
        liteModels: current.lightweightModels,
        providers: current.providers,
      }),
    ).toThrow()
  })

  test("rejects anonymous or trial-backed Free Auto routes", () => {
    expect(() => validate(config({ ...model, allowAnonymous: true }))).toThrow()
    expect(() => validate(config({ ...model, trialProvider: "primary" }))).toThrow()
    expect(() => validate(config({ ...model, stickyProvider: "strict" }))).toThrow(/шилжих боломжийг хааж болохгүй/)
  })

  test("normalizes every composite NVIDIA key as a fallback route", () => {
    const normalized = normalizeGatewayModelRoutes(model, {
      primary: [
        { id: "primary.a", key: "primary-key-a" },
        { id: "primary.b", key: "primary-key-b" },
        { id: "primary.c", key: "primary-key-c" },
      ],
      secondary: [
        { id: "secondary.a", key: "secondary-key-a" },
        { id: "secondary.b", key: "secondary-key-b" },
      ],
    })

    expect(normalized.fallbackProviders).toEqual(["secondary.a", "secondary.b"])
    expect(normalized.providers.map((provider) => provider.id)).toEqual([
      "primary.a",
      "primary.b",
      "primary.c",
      "secondary.a",
      "secondary.b",
    ])
    expect(
      normalized.providers
        .filter((provider) => provider.id.startsWith("primary."))
        .reduce((total, provider) => total + provider.weight, 0),
    ).toBe(
      normalized.providers
        .filter((provider) => provider.id.startsWith("secondary."))
        .reduce((total, provider) => total + provider.weight, 0),
    )
  })

  test("requires authenticated-free billing and a configured fallback", () => {
    expect(() => validate(config({ ...model, freeForAuthenticated: false }))).toThrow()
    expect(() => validate(config({ ...model, fallbackProvider: undefined }))).toThrow()
    expect(() => validate(config({ ...model, fallbackProvider: "missing" }))).toThrow()
    expect(() =>
      validate(
        config({
          ...model,
          providers: model.providers.map((provider) =>
            provider.id === model.fallbackProvider ? { ...provider, disabled: true } : provider,
          ),
        }),
      ),
    ).toThrow(/идэвхтэй нийлүүлэгчийн чиглэлийг заасан байх ёстой/)
    expect(() => validate(config({ ...model, providers: [...model.providers, model.providers[0]] }))).toThrow(
      /нийлүүлэгчийн чиглэл тухайн загвар дотор давхардаж болохгүй/,
    )
  })

  test("keeps the OpenCode install-time free route as the Free Auto base", () => {
    expect(() =>
      validate({
        ...config(model),
        providers: {
          ...config(model).providers,
          primary: { ...config(model).providers.primary, providerKind: "openrouter" },
        },
      }),
    ).toThrow(/MongolGPT-ийн суулгалттай дагалддаг үнэгүй чиглэлийг хадгалах ёстой/)
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

  test("rejects undefined providers in gateway model routes", () => {
    expect(() =>
      validate({
        ...config(model),
        models: {
          paid: {
            name: "Paid",
            cost: { input: 1, output: 1 },
            providers: [{ id: "missing", model: "paid-model" }],
          },
        },
      }),
    ).toThrow(/providers жагсаалтад/)
  })

  test("rejects undefined providers in lightweight model routes", () => {
    expect(() =>
      validate({
        ...config(model),
        models: {},
        lightweightModels: {
          lite: {
            name: "Lite",
            cost: { input: 1, output: 1 },
            providers: [{ id: "missing", model: "lite-model" }],
          },
        },
      }),
    ).toThrow(/providers жагсаалтад/)
  })

  test("rejects blank model ids in every provider route", () => {
    expect(() => validate(config({ ...model, providers: [{ id: "primary", model: "  " }] }))).toThrow(
      /загварын id хоосон байж болохгүй/,
    )
  })

  test("accepts only bounded nonnegative managed-model cost metadata", () => {
    expect(() =>
      validate({
        ...config(model),
        models: {
          paid: {
            name: "Paid",
            cost: { input: 0.000001, output: 0.000002 },
            maxTokensPerRequest: 32_000,
            providers: [{ id: "primary", model: "paid-model" }],
          },
        },
      }),
    ).not.toThrow()
    expect(() => validate(config({ ...model, cost: { input: -1, output: 1 } }))).toThrow()
    expect(() => validate(config({ ...model, maxTokensPerRequest: 0 }))).toThrow()
    expect(() =>
      validate({
        ...config(model),
        models: {
          paid: {
            name: "Paid",
            cost: { input: 0.000001, output: 0.000002 },
            providers: [{ id: "primary", model: "paid-model" }],
          },
        },
      }),
    ).toThrow(/maxTokensPerRequest/)
  })
})
