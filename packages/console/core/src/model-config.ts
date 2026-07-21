import { z } from "zod"

export const ModelFormatSchema = z.enum(["anthropic", "google", "openai", "oa-compat"])
export type ModelFormat = z.infer<typeof ModelFormatSchema>

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
      id: z.string().trim().min(1, "Model provider id must not be empty"),
      model: z.string().trim().min(1, "Provider route model id must not be empty"),
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
  productionUseApproved: z.boolean().optional(),
  format: ModelFormatSchema.optional(),
  headerModifier: z.record(z.string(), z.any()).optional(),
  payloadModifier: z.record(z.string(), z.any()).optional(),
  adjustCacheUsage: z.boolean().optional(),
  budget: z.number().optional(),
})

export const MongolGPTModelConfigurationSchema = z
  .object({
    zenModels: z.record(
      z.string(),
      z.union([MongolGPTModelSchema, z.array(MongolGPTModelSchema.extend({ formatFilter: ModelFormatSchema }))]),
    ),
    liteModels: z.record(
      z.string(),
      z.union([MongolGPTModelSchema, z.array(MongolGPTModelSchema.extend({ formatFilter: ModelFormatSchema }))]),
    ),
    providers: z.record(z.string(), ProviderSchema),
  })
  .superRefine((value, ctx) => {
    for (const [list, models] of [
      ["zenModels", value.zenModels],
      ["liteModels", value.liteModels],
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
                message: `Provider route "${route.id}" must be unique within the model`,
              })
            providerIDs.add(route.id)
            if (!value.providers[route.id])
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "providers", routeIndex, "id"],
                message: `Provider route "${route.id}" must reference the providers map`,
              })
          }

          if (model.fallbackProvider && !model.providers.some((provider) => provider.id === model.fallbackProvider))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "fallbackProvider"],
              message: "fallbackProvider must reference a route configured for the model",
            })
          if (
            model.fallbackProvider &&
            !model.providers.some((provider) => provider.id === model.fallbackProvider && !provider.disabled)
          )
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "fallbackProvider"],
              message: "fallbackProvider must reference an enabled provider route",
            })

          if (modelID !== "free-auto" && !model.maxTokensPerRequest)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "maxTokensPerRequest"],
              message: "Managed model must define maxTokensPerRequest for atomic quota reservation",
            })

          if (modelID !== "free-auto") continue

          if (model.allowAnonymous !== false)
            ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "Free Auto must require authentication" })
          if (model.freeForAuthenticated !== true)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto must use authenticated free billing",
            })
          if (model.trialProvider)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto cannot depend on a hosted trial provider",
            })
          if (!model.rateLimit)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto must define a per-account rate limit",
            })
          if (!model.freeWeeklyTokenLimit)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto must define a weekly token limit",
            })
          if (!model.freeMaxTokensPerRequest)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto must define a per-request billable token upper bound",
            })
          if (
            model.freeMaxTokensPerRequest &&
            model.freeWeeklyTokenLimit &&
            model.freeMaxTokensPerRequest > model.freeWeeklyTokenLimit
          )
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto per-request token upper bound cannot exceed its weekly token limit",
            })
          if (new Set(model.providers.filter((provider) => !provider.disabled).map((provider) => provider.id)).size < 2)
            ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "Free Auto must define a fallback route" })
          if (!model.fallbackProvider || !model.providers.some((provider) => provider.id === model.fallbackProvider))
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: "Free Auto fallbackProvider must reference a configured provider",
            })
        }
      }
    }
  })
