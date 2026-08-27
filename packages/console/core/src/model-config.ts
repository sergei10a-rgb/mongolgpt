import { z } from "zod"

export const ModelFormatSchema = z.enum(["anthropic", "google", "openai", "oa-compat"])
export type ModelFormat = z.infer<typeof ModelFormatSchema>
export const ProviderKindSchema = z.enum(["openrouter", "nvidia-nim", "openai-compatible"])
export const ProviderUsageModeSchema = z.enum(["managed", "byok", "trial"])

const unitCost = z.number().nonnegative()
const ModelCostSchema = z.object({
  input: unitCost,
  output: unitCost,
  cacheRead: unitCost.optional(),
  cacheWrite5m: unitCost.optional(),
  cacheWrite1h: unitCost.optional(),
})

export const MongolGPTModelSchema = z.object({
  name: z.string(),
  cost: ModelCostSchema,
  cost200K: ModelCostSchema.optional(),
  allowAnonymous: z.boolean().optional(),
  freeForAuthenticated: z.boolean().optional(),
  byokProvider: z.enum(["openai", "anthropic", "google"]).optional(),
  stickyProvider: z.enum(["strict", "prefer"]).optional(),
  trialProvider: z.string().optional(),
  trialEnded: z.boolean().optional(),
  fallbackProvider: z.string().optional(),
  rateLimit: z.number().optional(),
  maxTokensPerRequest: z.number().int().positive().optional(),
  freeWeeklyTokenLimit: z.number().int().positive().optional(),
  freeMaxTokensPerRequest: z.number().int().positive().optional(),
  providers: z.array(
    z.object({
      id: z.string().trim().min(1, "Загварын нийлүүлэгчийн id хоосон байж болохгүй"),
      model: z.string().trim().min(1, "Нийлүүлэгчийн чиглэлийн загварын id хоосон байж болохгүй"),
      priority: z.number().optional(),
      tpmLimit: z.number().optional(),
      tpsGoal: z.number().optional(),
      budgetMode: z.enum(["always", "fill"]).optional(),
      budgetContribution: z.number().optional(),
      weight: z.number().optional(),
      disabled: z.boolean().optional(),
      storeModel: z.string().optional(),
      payloadModifier: z.record(z.string(), z.any()).optional(),
    }),
  ),
})

const ProviderSchema = z.object({
  displayName: z.string().optional(),
  api: z.string(),
  apiKey: z.union([z.string(), z.record(z.string(), z.string())]),
  providerKind: ProviderKindSchema.optional(),
  usageMode: ProviderUsageModeSchema.optional(),
  productionUseApproved: z.boolean().optional(),
  format: ModelFormatSchema.optional(),
  headerModifier: z.record(z.string(), z.any()).optional(),
  payloadModifier: z.record(z.string(), z.any()).optional(),
  adjustCacheUsage: z.boolean().optional(),
  budget: z.number().optional(),
})

export type MongolGPTProviderConfig = z.infer<typeof ProviderSchema>

const ModelMapSchema = z.record(
  z.string(),
  z.union([MongolGPTModelSchema, z.array(MongolGPTModelSchema.extend({ formatFilter: ModelFormatSchema }))]),
)

const GatewayModelConfigurationSchema = z.object({
  models: ModelMapSchema,
  lightweightModels: ModelMapSchema,
  providers: z.record(z.string(), ProviderSchema),
})

const LegacyModelConfigurationSchema = z
  .object({
    zenModels: ModelMapSchema,
    liteModels: ModelMapSchema,
    providers: z.record(z.string(), ProviderSchema),
  })
  .transform(({ zenModels, liteModels, providers }) => ({
    models: zenModels,
    lightweightModels: liteModels,
    providers,
  }))

export function isProviderAllowedForStage(
  provider: Pick<MongolGPTProviderConfig, "productionUseApproved">,
  stage: string,
) {
  return stage !== "production" || provider.productionUseApproved === true
}

export const MongolGPTModelConfigurationSchema = z
  .union([GatewayModelConfigurationSchema, LegacyModelConfigurationSchema])
  .superRefine((value, ctx) => {
    for (const [list, models] of [
      ["models", value.models],
      ["lightweightModels", value.lightweightModels],
    ] as const) {
      for (const [modelID, configured] of Object.entries(models)) {
        for (const [index, model] of (Array.isArray(configured) ? configured : [configured]).entries()) {
          const path = [list, modelID, ...(Array.isArray(configured) ? [index] : [])]
          const providerIDs = new Set<string>()

          for (const [routeIndex, route] of model.providers.entries()) {
            if (providerIDs.has(route.id))
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "providers", routeIndex, "id"],
                message: `"${route.id}" нийлүүлэгчийн чиглэл тухайн загвар дотор давхардаж болохгүй`,
              })
            providerIDs.add(route.id)
            if (!value.providers[route.id])
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "providers", routeIndex, "id"],
                message: `"${route.id}" нийлүүлэгчийн чиглэл providers жагсаалтад заасан байх ёстой`,
              })
          }

          if (model.fallbackProvider && !model.providers.some((provider) => provider.id === model.fallbackProvider))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "fallbackProvider"],
              message: "fallbackProvider нь тухайн загварт тохируулсан чиглэлийг заасан байх ёстой",
            })
          if (
            model.fallbackProvider &&
            !model.providers.some((provider) => provider.id === model.fallbackProvider && !provider.disabled)
          )
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "fallbackProvider"],
              message: "fallbackProvider нь идэвхтэй нийлүүлэгчийн чиглэлийг заасан байх ёстой",
            })

          if (modelID !== "free-auto" && !model.maxTokensPerRequest)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "maxTokensPerRequest"],
              message: "Удирдлагатай загварт квотыг атомар нөөцлөх maxTokensPerRequest утга заасан байх ёстой",
            })

          if (modelID !== "free-auto") continue

          if (model.allowAnonymous !== false)
            ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "Free Auto нь нэвтрэлт шаарддаг байх ёстой" })
          if (model.freeForAuthenticated !== true)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto нь нэвтэрсэн хэрэглэгчийн үнэгүй тооцооллыг ашиглах ёстой",
            })
          if (model.trialProvider)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto нь байршуулсан туршилтын нийлүүлэгчээс хамаарах боломжгүй",
            })
          if (!model.rateLimit)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto нь бүртгэл тус бүрийн хүсэлтийн хязгаарыг заасан байх ёстой",
            })
          if (!model.freeWeeklyTokenLimit)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto нь долоо хоногийн токены хязгаарыг заасан байх ёстой",
            })
          if (!model.freeMaxTokensPerRequest)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto нь нэг хүсэлтэд тооцох токены дээд хязгаарыг заасан байх ёстой",
            })
          if (
            model.freeMaxTokensPerRequest &&
            model.freeWeeklyTokenLimit &&
            model.freeMaxTokensPerRequest > model.freeWeeklyTokenLimit
          )
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto-ийн нэг хүсэлтийн токены дээд хязгаар долоо хоногийн хязгаараас их байж болохгүй",
            })
          if (new Set(model.providers.filter((provider) => !provider.disabled).map((provider) => provider.id)).size < 2)
            ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "Free Auto нь нөөц чиглэл заасан байх ёстой" })
          if (!model.fallbackProvider || !model.providers.some((provider) => provider.id === model.fallbackProvider))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto-ийн fallbackProvider нь тохируулсан нийлүүлэгчийг заасан байх ёстой",
            })
        }
      }
    }
  })

export type MongolGPTModelConfiguration = z.infer<typeof MongolGPTModelConfigurationSchema>

export function modelConfigurationStageIssues(value: MongolGPTModelConfiguration, stage: string) {
  if (stage !== "production") return []

  const issues = new Set<string>()
  for (const [list, models] of [
    ["models", value.models],
    ["lightweightModels", value.lightweightModels],
  ] as const) {
    for (const [modelID, configured] of Object.entries(models)) {
      for (const [index, model] of (Array.isArray(configured) ? configured : [configured]).entries()) {
        const path = `${list}.${modelID}${Array.isArray(configured) ? `[${index}]` : ""}`
        const enabledRoutes = model.providers.filter((route) => !route.disabled)

        for (const route of enabledRoutes) {
          const provider = value.providers[route.id]
          if (provider?.usageMode !== "byok" && provider?.productionUseApproved !== true)
            issues.add(`${path}-ийн "${route.id}" үйлчилгээ үзүүлэгчийг productionUseApproved=true гэж тохируулах ёстой`)
        }

        if (modelID !== "free-auto") continue

        for (const route of enabledRoutes) {
          const provider = value.providers[route.id]
          if (provider && provider.usageMode !== "managed")
            issues.add(`${path}-ийн "${route.id}" үйлчилгээ үзүүлэгчийг usageMode=managed гэж тохируулах ёстой`)
        }

        const fallbackID = model.fallbackProvider
        const fallback = fallbackID ? value.providers[fallbackID] : undefined
        if (fallback && fallback.providerKind !== "nvidia-nim")
          issues.add(`${path}-ийн нөөц үйлчилгээ үзүүлэгч "${fallbackID}"-ийг providerKind=nvidia-nim гэж тохируулах ёстой`)

        for (const route of enabledRoutes.filter((route) => route.id !== fallbackID)) {
          const provider = value.providers[route.id]
          if (provider && provider.providerKind !== "openrouter")
            issues.add(`${path}-ийн үндсэн үйлчилгээ үзүүлэгч "${route.id}"-ийг providerKind=openrouter гэж тохируулах ёстой`)
        }
      }
    }
  }
  return [...issues]
}
