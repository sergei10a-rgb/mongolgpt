import type { SessionConfigOption } from "@agentclientprotocol/sdk"

export const DEFAULT_VARIANT_VALUE = "default"

export type ConfigOptionModel = {
  id: string
  name: string
  variants?: Record<string, Record<string, unknown>>
}

export type ConfigOptionProvider = {
  id: string
  name: string
  models: Record<string, ConfigOptionModel>
}

export type ConfigOptionMode = {
  id: string
  name: string
  description?: string
}

export type ModelSelection = {
  model: {
    providerID: string
    modelID: string
  }
  variant?: string
}

export function buildModelSelectOption(input: {
  providers: readonly ConfigOptionProvider[]
  currentModel: ModelSelection["model"]
  currentVariant?: string
  includeVariants?: boolean
}): SessionConfigOption {
  return {
    id: "model",
    name: "Модел",
    category: "model",
    type: "select",
    currentValue: formatCurrentModelId({
      model: input.currentModel,
      variant: input.currentVariant,
      variants: variantsForModel(input.providers, input.currentModel),
      includeVariant: input.includeVariants ?? false,
    }),
    options: buildModelSelectOptions(input.providers, { includeVariants: input.includeVariants ?? false }),
  }
}

export function buildEffortSelectOption(input: {
  variants: readonly string[]
  currentVariant?: string
}): SessionConfigOption | undefined {
  if (input.variants.length === 0) return undefined

  return {
    id: "effort",
    name: "Бодолтын түвшин",
    description: "Энэ моделийн бодолтын түвшнийг сонгоно.",
    category: "thought_level",
    type: "select",
    currentValue: selectVariant(input.currentVariant, input.variants),
    options: input.variants.map((variant) => ({
      value: variant,
      name: formatVariantName(variant),
    })),
  }
}

export function buildModeSelectOption(input: {
  modes: readonly ConfigOptionMode[]
  currentModeId: string
}): SessionConfigOption {
  return {
    id: "mode",
    name: "Сессийн горим",
    category: "mode",
    type: "select",
    currentValue: input.currentModeId,
    options: input.modes.map((mode) => ({
      value: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  }
}

export function buildConfigOptions(input: {
  providers: readonly ConfigOptionProvider[]
  currentModel: ModelSelection["model"]
  currentVariant?: string
  includeModelVariants?: boolean
  modes?: readonly ConfigOptionMode[]
  currentModeId?: string
}): SessionConfigOption[] {
  const variants = variantsForModel(input.providers, input.currentModel)
  const effort = buildEffortSelectOption({ variants, currentVariant: input.currentVariant })

  return [
    buildModelSelectOption({
      providers: input.providers,
      currentModel: input.currentModel,
      currentVariant: input.currentVariant,
      includeVariants: input.includeModelVariants ?? false,
    }),
    ...(effort ? [effort] : []),
    ...(input.modes && input.currentModeId
      ? [buildModeSelectOption({ modes: input.modes, currentModeId: input.currentModeId })]
      : []),
  ]
}

export function parseModelSelection(modelId: string, providers: readonly ConfigOptionProvider[]): ModelSelection {
  const provider = providers.find((item) => modelId.startsWith(`${item.id}/`))
  if (provider) {
    const modelID = modelId.slice(provider.id.length + 1)
    if (provider.models[modelID]) {
      return { model: { providerID: provider.id, modelID } }
    }

    const separator = modelID.lastIndexOf("/")
    if (separator > -1) {
      const baseModelID = modelID.slice(0, separator)
      const variant = modelID.slice(separator + 1)
      if (provider.models[baseModelID]?.variants?.[variant]) {
        return { model: { providerID: provider.id, modelID: baseModelID }, variant }
      }
    }

    return { model: { providerID: provider.id, modelID } }
  }

  const separator = modelId.indexOf("/")
  if (separator === -1) {
    return { model: { providerID: modelId, modelID: "" } }
  }

  return {
    model: {
      providerID: modelId.slice(0, separator),
      modelID: modelId.slice(separator + 1),
    },
  }
}

export function formatCurrentModelId(input: {
  model: ModelSelection["model"]
  variant?: string
  variants?: readonly string[]
  includeVariant?: boolean
}) {
  const base = `${input.model.providerID}/${input.model.modelID}`
  if (!input.includeVariant || !input.variants?.length) return base
  return `${base}/${selectVariant(input.variant, input.variants)}`
}

export function formatVariantName(variant: string) {
  const known: Record<string, string> = {
    default: "Өгөгдмөл",
    minimal: "Хамгийн бага",
    low: "Бага",
    medium: "Дунд",
    high: "Өндөр",
    xhigh: "Маш өндөр",
    "very-high": "Маш өндөр",
    max: "Дээд",
    auto: "Автомат",
    none: "Үгүй",
  }
  const normalized = variant.toLowerCase().replaceAll("_", "-")
  if (known[normalized]) return known[normalized]

  const words: Record<string, string> = {
    very: "маш",
    high: "өндөр",
    low: "бага",
    medium: "дунд",
    minimal: "хамгийн бага",
    max: "дээд",
    effort: "чармайлт",
    reasoning: "бодолт",
    thinking: "бодолт",
  }
  const label = variant
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => words[part.toLowerCase()] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : label
}

function buildModelSelectOptions(
  providers: readonly ConfigOptionProvider[],
  options: { includeVariants: boolean },
): Array<{ value: string; name: string }> {
  return providers.flatMap((provider) =>
    Object.values(provider.models)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((model) => {
        const base = {
          value: `${provider.id}/${model.id}`,
          name: `${provider.name}/${model.name}`,
        }
        if (!options.includeVariants || !model.variants) return [base]

        return [
          base,
          ...Object.keys(model.variants)
            .filter((variant) => variant !== DEFAULT_VARIANT_VALUE)
            .map((variant) => ({
              value: `${provider.id}/${model.id}/${variant}`,
              name: `${provider.name}/${model.name} (${formatVariantName(variant)})`,
            })),
        ]
      }),
  )
}

function variantsForModel(providers: readonly ConfigOptionProvider[], model: ModelSelection["model"]) {
  return Object.keys(
    providers.find((provider) => provider.id === model.providerID)?.models[model.modelID]?.variants ?? {},
  )
}

function selectVariant(variant: string | undefined, variants: readonly string[]) {
  if (variant && variants.includes(variant)) return variant
  if (variants.includes(DEFAULT_VARIANT_VALUE)) return DEFAULT_VARIANT_VALUE
  return variants[0]
}
