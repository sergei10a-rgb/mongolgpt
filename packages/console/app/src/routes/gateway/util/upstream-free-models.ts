import { GatewayCatalog } from "@mongolgpt/console-core/model.js"

const CATALOG_URL = "https://models.dev/api.json"
const CACHE_TTL_MS = 5 * 60 * 1_000
const RETRY_TTL_MS = 30 * 1_000
const MAX_CATALOG_BYTES = 8 * 1024 * 1024
const MAX_FREE_MODELS = 128
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/

type GatewayCatalogData = ReturnType<typeof GatewayCatalog.list>
type GatewayModel = GatewayCatalogData["models"][string]
type GatewayModelArray = Extract<GatewayModel, readonly unknown[]>
type FormatGatewayModel = GatewayModelArray[number]
type SingleGatewayModel = Exclude<GatewayModel, readonly unknown[]>
type NormalizedGatewayModel = SingleGatewayModel | FormatGatewayModel

export type UpstreamFreeModel = {
  id: string
  name: string
  format: GatewayCatalog.Format
}

type Cache = {
  expiresAt: number
  models: UpstreamFreeModel[]
  pending?: Promise<UpstreamFreeModel[]>
}

let cache: Cache | undefined

export function resetUpstreamFreeModelsCacheForTest() {
  cache = undefined
}

export function parseUpstreamFreeModels(value: unknown): UpstreamFreeModel[] {
  if (!isRecord(value)) return []
  const provider = value.opencode
  if (!isRecord(provider) || !isRecord(provider.models)) return []

  const result: UpstreamFreeModel[] = []
  const seen = new Set<string>()
  for (const [id, raw] of Object.entries(provider.models)) {
    if (!isRecord(raw) || raw.status === "deprecated" || raw.status === "alpha" || !isZeroCost(raw.cost)) continue
    const modelID = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : id.trim()
    if (!MODEL_ID_PATTERN.test(modelID) || seen.has(modelID) || !isValidLimit(raw.limit)) continue
    const rawName = typeof raw.name === "string" ? raw.name.trim() : ""
    const name = rawName && rawName.length <= 160 ? rawName : modelID
    const modelProvider = isRecord(raw.provider) ? raw.provider : undefined
    const packageName = typeof modelProvider?.npm === "string" ? modelProvider.npm : provider.npm
    seen.add(modelID)
    result.push({ id: modelID, name, format: providerFormat(packageName) })
    if (result.length >= MAX_FREE_MODELS) break
  }
  return result
}

export async function loadUpstreamFreeModels(
  dependencies: {
    request?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    now?: () => number
    timeoutMs?: number
  } = {},
) {
  const now = (dependencies.now ?? Date.now)()
  if (cache && cache.expiresAt > now && cache.models.length > 0) return cache.models
  if (cache?.pending) return cache.pending

  const previous = cache?.models ?? []
  const pending = (async () => {
    try {
      const response = await (dependencies.request ?? fetch)(CATALOG_URL, {
        headers: { Accept: "application/json", "User-Agent": "MongolGPT-gateway" },
        signal: AbortSignal.timeout(dependencies.timeoutMs ?? 4_000),
      })
      if (!response.ok) throw new Error(`catalog status ${response.status}`)
      const models = parseUpstreamFreeModels(await readLimitedJson(response))
      if (models.length === 0) throw new Error("catalog has no active free models")
      cache = { expiresAt: now + CACHE_TTL_MS, models }
      return models
    } catch (error) {
      console.error("MongolGPT Free Auto каталогийг шинэчилж чадсангүй", {
        error: error instanceof Error ? error.message : String(error),
      })
      cache = { expiresAt: now + RETRY_TTL_MS, models: previous }
      return previous
    }
  })()
  cache = { expiresAt: cache?.expiresAt ?? 0, models: previous, pending }
  return pending
}

export function expandUpstreamFreeModels(catalog: GatewayCatalogData, models: readonly UpstreamFreeModel[]) {
  if (models.length === 0) return catalog

  const result: GatewayCatalogData = {
    providers: { ...catalog.providers },
    models: { ...catalog.models },
  }
  const configured = result.models["free-auto"]
  if (!configured) return result

  const template = (() => {
    if (Array.isArray(configured)) {
      const expanded = configured.map((variant) => expandFreeAutoVariant(result, variant, models))
      result.models["free-auto"] = expanded
      return expanded[0]
    }
    const expanded = expandFreeAutoVariant(result, configured, models)
    result.models["free-auto"] = expanded
    return expanded
  })()
  if (!template) return result
  for (const model of models) {
    if (result.models[model.id]) continue
    const route = template.providers.find((item) => item.model === model.id)
    if (!route) continue
    result.models[model.id] = {
      ...template,
      name: model.name,
      fallbackProviders: undefined,
      providers: [route],
    }
  }
  return result
}

export function upstreamFreePolicyModelID(
  modelID: string,
  baseCatalog: GatewayCatalogData,
  models: readonly UpstreamFreeModel[],
) {
  if (modelID === "free-auto") return modelID
  if (modelID in baseCatalog.models) return modelID
  return models.some((model) => model.id === modelID) ? "free-auto" : modelID
}

function expandFreeAutoVariant(
  catalog: GatewayCatalogData,
  model: FormatGatewayModel,
  freeModels: readonly UpstreamFreeModel[],
): FormatGatewayModel
function expandFreeAutoVariant(
  catalog: GatewayCatalogData,
  model: SingleGatewayModel,
  freeModels: readonly UpstreamFreeModel[],
): SingleGatewayModel
function expandFreeAutoVariant(
  catalog: GatewayCatalogData,
  model: NormalizedGatewayModel,
  freeModels: readonly UpstreamFreeModel[],
): NormalizedGatewayModel {
  const expandedByBase = new Map<string, string[]>()
  const providers = model.providers.flatMap((route) => {
    const provider = catalog.providers[route.id]
    // Dynamic discovery is permitted only through OpenCode's public, non-billable route.
    if (provider?.providerKind !== "mongolgpt-base-free" || provider.apiKey !== "public") return [route]

    const expanded = freeModels.map((freeModel) => {
      const id = dynamicProviderID(route.id, freeModel.id)
      catalog.providers[id] = {
        ...provider,
        displayName: "MongolGPT Free Auto",
        format: freeModel.format,
      }
      return { ...route, id, model: freeModel.id }
    })
    expandedByBase.set(
      route.id,
      expanded.map((item) => item.id),
    )
    return expanded
  })
  if (expandedByBase.size === 0) return model

  const existingFallbacks = model.fallbackProviders ?? []
  const fallbackProviders = existingFallbacks.flatMap((id) => {
    const expanded = expandedByBase.get(id)
    return expanded ? expanded.slice(-1) : [id]
  })
  if (fallbackProviders.length === 0 && providers.length > 1) {
    const dynamic = providers.filter((route) => expandedByBase.has(baseProviderID(route.id)))
    const last = dynamic.at(-1)
    if (last) fallbackProviders.push(last.id)
  }

  return { ...model, providers, fallbackProviders: fallbackProviders.length ? fallbackProviders : undefined }
}

function dynamicProviderID(base: string, model: string) {
  const slug =
    model
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "model"
  return `${base}--${slug}-${stableHash(model)}`
}

function baseProviderID(id: string) {
  const marker = id.indexOf("--")
  return marker === -1 ? id : id.slice(0, marker)
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function providerFormat(value: unknown): GatewayCatalog.Format {
  if (value === "@ai-sdk/anthropic") return "anthropic"
  if (value === "@ai-sdk/google") return "google"
  if (value === "@ai-sdk/openai") return "openai"
  return "oa-compat"
}

function isZeroCost(value: unknown) {
  if (!isRecord(value) || value.input !== 0 || value.output !== 0) return false
  if (!isOptionalZero(value.cache_read) || !isOptionalZero(value.cache_write)) return false
  if (value.context_over_200k !== undefined && !isZeroCost(value.context_over_200k)) return false
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) return false
    if (value.tiers.some((tier) => !isZeroCost(tier))) return false
  }
  return true
}

async function readLimitedJson(response: Response) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) throw new Error("catalog is too large")
  if (!response.body) return JSON.parse(await response.text())

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_CATALOG_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error("catalog is too large")
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return JSON.parse(text)
}

function isOptionalZero(value: unknown) {
  return value === undefined || value === 0
}

function isValidLimit(value: unknown) {
  if (!isRecord(value)) return false
  return typeof value.context === "number" && Number.isFinite(value.context) && value.context > 0
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
