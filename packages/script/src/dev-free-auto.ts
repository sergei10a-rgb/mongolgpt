import {
  MongolGPTModelConfigurationSchema,
  type MongolGPTModelConfiguration,
} from "@mongolgpt/console-core/model-config.js"

export const MODEL_SECRET_PARTS = 30
export const DEFAULT_MONGOLGPT_BASE_FREE_MODEL = "mimo-v2.5-free"
export const BASE_FREE_PUBLIC_API_KEY = "public"
export const DEFAULT_NVIDIA_NIM_MODEL = "qwen/qwen2.5-coder-32b-instruct"
export const OPENROUTER_BYOK_MODEL = "openrouter/free"
export const BYOK_CREDENTIAL_SENTINEL = "byok-required"

export type DevFreeAutoPreparation = {
  source: "disabled" | "legacy" | "managed"
  parts: string[]
}

type Input = {
  legacyParts?: readonly string[]
  baseFreeModel?: string
  openRouterApiKey?: string
  nvidiaNimApiKey?: string
  nvidiaNimModel?: string
  requireEnabled?: boolean
}

export function buildDevFreeAutoCatalog(input: {
  baseFreeModel?: string
  openRouterApiKey?: string
  nvidiaNimApiKey?: string
  nvidiaNimModel?: string
}): MongolGPTModelConfiguration {
  const baseFreeModel = identifier(
    input.baseFreeModel ?? DEFAULT_MONGOLGPT_BASE_FREE_MODEL,
    "MONGOLGPT_BASE_FREE_MODEL_ID",
  )
  const openRouterApiKey = optionalSecret(input.openRouterApiKey, "OPENROUTER_API_KEY")
  const nvidiaNimApiKey = optionalSecret(input.nvidiaNimApiKey, "NVIDIA_NIM_API_KEY")
  const nvidiaNimModel = identifier(input.nvidiaNimModel ?? DEFAULT_NVIDIA_NIM_MODEL, "NVIDIA_NIM_MODEL_ID")
  const managedRoutes = [
    { id: "mongolgpt-base-free", model: baseFreeModel, priority: 0 },
    ...(openRouterApiKey ? [{ id: "openrouter-free", model: "openrouter/free", priority: 1 }] : []),
    ...(nvidiaNimApiKey ? [{ id: "nvidia-nim-free", model: nvidiaNimModel, priority: 2 }] : []),
  ]
  const fallbackProvider = nvidiaNimApiKey
    ? "nvidia-nim-free"
    : openRouterApiKey
      ? "openrouter-free"
      : undefined

  return MongolGPTModelConfigurationSchema.parse({
    models: {
      "free-auto": {
        name: "MongolGPT Free Auto",
        cost: { input: 0, output: 0 },
        allowAnonymous: false,
        freeForAuthenticated: true,
        fallbackProvider,
        rateLimit: 20,
        freeWeeklyTokenLimit: 100_000,
        freeMaxTokensPerRequest: 8_192,
        providers: managedRoutes,
      },
      "openrouter-byok": {
        name: "OpenRouter (өөрийн түлхүүр)",
        cost: { input: 0, output: 0 },
        byokProvider: "openrouter",
        maxTokensPerRequest: 8_192,
        providers: [{ id: "openrouter", model: OPENROUTER_BYOK_MODEL }],
      },
      "nvidia-nim-byok": {
        name: "NVIDIA NIM (өөрийн түлхүүр)",
        cost: { input: 0, output: 0 },
        byokProvider: "nvidia-nim",
        maxTokensPerRequest: 8_192,
        providers: [{ id: "nvidia-nim", model: nvidiaNimModel }],
      },
    },
    lightweightModels: {},
    providers: {
      "mongolgpt-base-free": {
        displayName: "MongolGPT суурь үнэгүй чиглэл",
        api: "https://opencode.ai/zen/v1",
        apiKey: BASE_FREE_PUBLIC_API_KEY,
        providerKind: "mongolgpt-base-free",
        usageMode: "managed",
        productionUseApproved: false,
      },
      ...(openRouterApiKey
        ? {
            "openrouter-free": {
              displayName: "OpenRouter Free",
              api: "https://openrouter.ai/api/v1",
              apiKey: openRouterApiKey,
              providerKind: "openrouter" as const,
              usageMode: "managed" as const,
              productionUseApproved: false,
              headerModifier: {
                "HTTP-Referer": "https://dev.mgpt.mn",
                "X-Title": "MongolGPT",
              },
            },
          }
        : {}),
      ...(nvidiaNimApiKey
        ? {
            "nvidia-nim-free": {
              displayName: "NVIDIA NIM Developer API",
              api: "https://integrate.api.nvidia.com/v1",
              apiKey: nvidiaNimApiKey,
              providerKind: "nvidia-nim" as const,
              usageMode: "managed" as const,
              productionUseApproved: false,
            },
          }
        : {}),
      openrouter: {
        displayName: "OpenRouter BYOK",
        api: "https://openrouter.ai/api/v1",
        apiKey: BYOK_CREDENTIAL_SENTINEL,
        providerKind: "openrouter",
        usageMode: "byok",
        headerModifier: {
          "HTTP-Referer": "https://dev.mgpt.mn",
          "X-Title": "MongolGPT",
        },
      },
      "nvidia-nim": {
        displayName: "NVIDIA NIM BYOK",
        api: "https://integrate.api.nvidia.com/v1",
        apiKey: BYOK_CREDENTIAL_SENTINEL,
        providerKind: "nvidia-nim",
        usageMode: "byok",
      },
    },
  })
}

export function prepareDevFreeAuto(input: Input): DevFreeAutoPreparation {
  const legacyParts = Array.from({ length: MODEL_SECRET_PARTS }, (_, index) => input.legacyParts?.[index] ?? "")
  if (legacyParts.some(Boolean)) {
    if (!legacyParts[0]) throw new Error("Хуучин gateway catalog-ийн эхний хэсэг MONGOLGPT_GATEWAY_MODELS1 дутуу байна.")
    validateCanonicalCatalog(legacyParts.join(""))
    return { source: "legacy", parts: legacyParts }
  }

  const canonical = JSON.stringify(
    buildDevFreeAutoCatalog({
      baseFreeModel: input.baseFreeModel,
      openRouterApiKey: input.openRouterApiKey,
      nvidiaNimApiKey: input.nvidiaNimApiKey,
      nvidiaNimModel: input.nvidiaNimModel,
    }),
  )
  return { source: "managed", parts: splitCanonicalCatalog(canonical) }
}

export function gatewaySstEnvironmentLines(parts: readonly string[]) {
  return Array.from({ length: MODEL_SECRET_PARTS }, (_, index) => {
    const value = parts[index] ?? ""
    if (/\r|\n/.test(value)) throw new Error(`Gateway catalog-ийн ${index + 1}-р хэсэг мөр шилжүүлсэн тэмдэгт агуулж байна.`)
    return `SST_SECRET_MONGOLGPT_GATEWAY_MODELS${index + 1}=${value}`
  })
}

function splitCanonicalCatalog(canonical: string) {
  const maximumPartLength = 40_000
  const count = Math.ceil(canonical.length / maximumPartLength)
  if (count > MODEL_SECRET_PARTS) throw new Error("Gateway catalog GitHub secret-ийн зөвшөөрөгдөх хэмжээнээс хэтэрлээ.")
  return Array.from({ length: MODEL_SECRET_PARTS }, (_, index) =>
    canonical.slice(index * maximumPartLength, (index + 1) * maximumPartLength),
  )
}

function validateCanonicalCatalog(canonical: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(canonical)
  } catch {
    throw new Error("Хуучин gateway catalog хүчинтэй JSON биш байна.")
  }
  try {
    MongolGPTModelConfigurationSchema.parse(parsed)
  } catch {
    throw new Error("Хуучин gateway catalog схемд нийцэхгүй байна.")
  }
}

function secret(value: string, name: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} хоосон байна.`)
  if (/\r|\n/.test(normalized)) throw new Error(`${name} мөр шилжүүлсэн тэмдэгт агуулж болохгүй.`)
  return normalized
}

function optionalSecret(value: string | undefined, name: string) {
  if (!value?.trim()) return undefined
  return secret(value, name)
}

function identifier(value: string, name: string) {
  const normalized = value.trim()
  if (!normalized || /\s|[\r\n]/.test(normalized)) throw new Error(`${name} хүчинтэй model ID биш байна.`)
  return normalized
}
