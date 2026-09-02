import { describe, expect, test } from "bun:test"
import { MongolGPTModelConfigurationSchema, modelConfigurationStageIssues } from "@mongolgpt/console-core/model-config.js"
import {
  BYOK_CREDENTIAL_SENTINEL,
  DEFAULT_MONGOLGPT_BASE_FREE_MODEL,
  DEFAULT_NVIDIA_NIM_MODEL,
  MODEL_SECRET_PARTS,
  OPENROUTER_BYOK_MODEL,
  buildDevFreeAutoCatalog,
  gatewaySstEnvironmentLines,
  prepareDevFreeAuto,
} from "../src/dev-free-auto"

describe("dev Free Auto catalog", () => {
  test("keeps the OpenCode free tier enabled without extra provider keys", () => {
    const result = prepareDevFreeAuto({})
    const catalog = MongolGPTModelConfigurationSchema.parse(JSON.parse(result.parts.join("")))
    const freeAuto = catalog.models["free-auto"]

    expect(result.source).toBe("managed")
    expect(result.parts).toHaveLength(MODEL_SECRET_PARTS)
    if (Array.isArray(freeAuto) || !freeAuto) throw new Error("Free Auto catalog дутуу байна")
    expect(freeAuto.providers).toEqual([
      { id: "mongolgpt-base-free", model: DEFAULT_MONGOLGPT_BASE_FREE_MODEL, priority: 0 },
    ])
    expect(freeAuto.fallbackProvider).toBeUndefined()
    expect(catalog.providers["mongolgpt-base-free"]).toMatchObject({
      api: "https://opencode.ai/zen/v1",
      apiKey: "public",
      providerKind: "mongolgpt-base-free",
      usageMode: "managed",
    })
  })

  test("keeps full deployment Free Auto enabled without extra secrets", () => {
    expect(prepareDevFreeAuto({ requireEnabled: true }).source).toBe("managed")
  })

  test("treats empty GitHub Actions model overrides as unset", () => {
    const result = prepareDevFreeAuto({ baseFreeModel: "", nvidiaNimModel: "  " })
    const catalog = MongolGPTModelConfigurationSchema.parse(JSON.parse(result.parts.join("")))
    const freeAuto = catalog.models["free-auto"]
    if (Array.isArray(freeAuto) || !freeAuto) throw new Error("Free Auto catalog дутуу байна")

    expect(freeAuto.providers[0]?.model).toBe(DEFAULT_MONGOLGPT_BASE_FREE_MODEL)
    expect(catalog.models["nvidia-nim-byok"]).toMatchObject({
      providers: [{ id: "nvidia-nim", model: DEFAULT_NVIDIA_NIM_MODEL }],
    })
  })

  test("adds OpenRouter independently as a managed fallback", () => {
    const result = prepareDevFreeAuto({ openRouterApiKey: "openrouter-test-key" })
    const catalog = MongolGPTModelConfigurationSchema.parse(JSON.parse(result.parts.join("")))
    const freeAuto = catalog.models["free-auto"]
    if (Array.isArray(freeAuto) || !freeAuto) throw new Error("Free Auto catalog дутуу байна")

    expect(freeAuto.providers).toEqual([
      { id: "mongolgpt-base-free", model: DEFAULT_MONGOLGPT_BASE_FREE_MODEL, priority: 0 },
      { id: "openrouter-free", model: "openrouter/free", priority: 1 },
    ])
    expect(freeAuto.fallbackProvider).toBe("openrouter-free")
  })

  test("builds a schema-valid OpenCode to OpenRouter to NVIDIA catalog", () => {
    const result = prepareDevFreeAuto({
      openRouterApiKey: "openrouter-test-key",
      nvidiaNimApiKey: "nvidia-test-key",
    })
    const catalog = MongolGPTModelConfigurationSchema.parse(JSON.parse(result.parts.join("")))
    const freeAuto = catalog.models["free-auto"]

    expect(result.source).toBe("managed")
    expect(Array.isArray(freeAuto)).toBe(false)
    if (Array.isArray(freeAuto) || !freeAuto) throw new Error("Free Auto catalog дутуу байна")
    expect(freeAuto.providers).toEqual([
      { id: "mongolgpt-base-free", model: DEFAULT_MONGOLGPT_BASE_FREE_MODEL, priority: 0 },
      { id: "openrouter-free", model: "openrouter/free", priority: 1 },
      { id: "nvidia-nim-free", model: DEFAULT_NVIDIA_NIM_MODEL, priority: 2 },
    ])
    expect(freeAuto.fallbackProvider).toBe("nvidia-nim-free")
    expect(catalog.providers["openrouter-free"]?.productionUseApproved).toBe(false)
    expect(catalog.providers["nvidia-nim-free"]?.productionUseApproved).toBe(false)
    expect(catalog.models["openrouter-byok"]).toMatchObject({
      byokProvider: "openrouter",
      providers: [{ id: "openrouter", model: OPENROUTER_BYOK_MODEL }],
    })
    expect(catalog.models["nvidia-nim-byok"]).toMatchObject({
      byokProvider: "nvidia-nim",
      providers: [{ id: "nvidia-nim", model: DEFAULT_NVIDIA_NIM_MODEL }],
    })
    expect(catalog.providers.openrouter).toMatchObject({
      apiKey: BYOK_CREDENTIAL_SENTINEL,
      usageMode: "byok",
    })
    expect(catalog.providers["nvidia-nim"]).toMatchObject({
      apiKey: BYOK_CREDENTIAL_SENTINEL,
      usageMode: "byok",
    })
    expect(modelConfigurationStageIssues(catalog, "dev")).toEqual([])
    expect(modelConfigurationStageIssues(catalog, "production")).not.toEqual([])
  })

  test("allows an explicit NVIDIA model override", () => {
    const catalog = buildDevFreeAutoCatalog({
      openRouterApiKey: "openrouter-test-key",
      nvidiaNimApiKey: "nvidia-test-key",
      nvidiaNimModel: "meta/llama-3.1-8b-instruct",
    })
    const freeAuto = catalog.models["free-auto"]
    if (Array.isArray(freeAuto) || !freeAuto) throw new Error("Free Auto catalog дутуу байна")

    expect(freeAuto.providers[2]?.model).toBe("meta/llama-3.1-8b-instruct")
  })

  test("allows the OpenCode free model to be updated without a secret", () => {
    const catalog = buildDevFreeAutoCatalog({ baseFreeModel: "nemotron-3.5-lightning-free" })
    const freeAuto = catalog.models["free-auto"]
    if (Array.isArray(freeAuto) || !freeAuto) throw new Error("Free Auto catalog дутуу байна")

    expect(freeAuto.providers[0]).toEqual({
      id: "mongolgpt-base-free",
      model: "nemotron-3.5-lightning-free",
      priority: 0,
    })
  })

  test("preserves and validates the legacy multipart catalog", () => {
    const catalog = buildDevFreeAutoCatalog({
      openRouterApiKey: "legacy-openrouter-key",
      nvidiaNimApiKey: "legacy-nvidia-key",
    })
    const canonical = JSON.stringify(catalog)
    const result = prepareDevFreeAuto({ legacyParts: [canonical.slice(0, 80), canonical.slice(80)] })

    expect(result.source).toBe("legacy")
    expect(result.parts.join("")).toBe(canonical)
  })

  test("does not reveal a legacy provider key when schema validation fails", () => {
    const providerKey = "legacy-secret-that-must-not-appear"
    let message = ""
    try {
      prepareDevFreeAuto({ legacyParts: [JSON.stringify({ models: {}, providers: { invalid: { apiKey: providerKey } } })] })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toBe("Хуучин gateway catalog схемд нийцэхгүй байна.")
    expect(message).not.toContain(providerKey)
  })

  test("serializes bounded SST environment variables without revealing diagnostics", () => {
    const lines = gatewaySstEnvironmentLines(["{\"models\":{}}"])

    expect(lines).toHaveLength(MODEL_SECRET_PARTS)
    expect(lines[0]).toBe('SST_SECRET_MONGOLGPT_GATEWAY_MODELS1={"models":{}}')
    expect(lines[29]).toBe("SST_SECRET_MONGOLGPT_GATEWAY_MODELS30=")
    expect(() => gatewaySstEnvironmentLines(["unsafe\nvalue"])).toThrow("мөр шилжүүлсэн")
  })
})
