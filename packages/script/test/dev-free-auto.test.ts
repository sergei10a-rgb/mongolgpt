import { describe, expect, test } from "bun:test"
import { MongolGPTModelConfigurationSchema, modelConfigurationStageIssues } from "@mongolgpt/console-core/model-config.js"
import {
  BYOK_CREDENTIAL_SENTINEL,
  DEFAULT_NVIDIA_NIM_MODEL,
  MODEL_SECRET_PARTS,
  OPENROUTER_BYOK_MODEL,
  buildDevFreeAutoCatalog,
  gatewaySstEnvironmentLines,
  prepareDevFreeAuto,
} from "../src/dev-free-auto"

describe("dev Free Auto catalog", () => {
  test("stays disabled when neither managed provider key exists", () => {
    const result = prepareDevFreeAuto({})

    expect(result.source).toBe("disabled")
    expect(result.parts).toHaveLength(MODEL_SECRET_PARTS)
    expect(result.parts.every((part) => part === "")).toBe(true)
  })

  test("rejects a partially configured managed fallback", () => {
    expect(() => prepareDevFreeAuto({ openRouterApiKey: "openrouter-test-key" })).toThrow(
      "OPENROUTER_API_KEY болон NVIDIA_NIM_API_KEY хоёул шаардлагатай",
    )
  })

  test("builds a schema-valid dev-only OpenRouter to NVIDIA catalog", () => {
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
      { id: "openrouter-free", model: "openrouter/free", priority: 0 },
      { id: "nvidia-nim-free", model: DEFAULT_NVIDIA_NIM_MODEL, priority: 1 },
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

    expect(freeAuto.providers[1]?.model).toBe("meta/llama-3.1-8b-instruct")
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
