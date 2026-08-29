import { z } from "zod"
import { eq, and } from "drizzle-orm"
import { Database } from "./drizzle"
import { ModelTable } from "./schema/model.sql"
import { Identifier } from "./identifier"
import { fn } from "./util/fn"
import { Actor } from "./actor"
import { Resource } from "@mongolgpt/console-resource"
import {
  modelConfigurationStageIssues,
  MongolGPTModelConfigurationSchema,
  MongolGPTModelSchema,
  type ModelFormat,
} from "./model-config"

type GatewayModel = z.infer<typeof MongolGPTModelSchema>
type CompositeProviders = Record<string, Array<{ id: string; key: string }>>

export class GatewayConfigurationError extends Error {
  constructor() {
    super("Free Auto одоогоор идэвхгүй байна: загварын тохиргоо дутуу эсвэл буруу байна. Админ тохиргоог шалгана уу.")
  }
}

export function normalizeGatewayModelRoutes(model: GatewayModel, compositeProviders: CompositeProviders) {
  const providers = model.providers.map((provider) => ({
    ...provider,
    priority: provider.priority ?? Infinity,
    weight: provider.weight ?? 1,
  }))
  const gcd = (left: number, right: number): number => (right === 0 ? left : gcd(right, left % right))
  const weightScale = providers.reduce((scale, provider) => {
    const count = compositeProviders[provider.id].length
    return (scale * count) / gcd(scale, count)
  }, 1)
  const expandProvider = (providerID: string) =>
    compositeProviders[providerID]?.map((provider) => provider.id) ?? [providerID]
  const fallbackProviders = model.fallbackProvider
    ? expandProvider(model.fallbackProvider)
    : undefined

  return {
    trialProvider: model.trialProvider ? expandProvider(model.trialProvider) : undefined,
    fallbackProviders,
    providers: providers.flatMap((provider) =>
      compositeProviders[provider.id].map((sub) => ({
        ...provider,
        id: sub.id,
        weight: (provider.weight * weightScale) / compositeProviders[provider.id].length,
      })),
    ),
  }
}

export namespace GatewayCatalog {
  export type Format = ModelFormat
  const ModelsSchema = MongolGPTModelConfigurationSchema

  export const validate = fn(ModelsSchema, (input) => {
    return input
  })

  export const parseConfiguration = fn(
    z.object({
      canonical: z.string(),
      stage: z.string(),
    }),
    ({ canonical, stage }) => {
      let configuration: z.infer<typeof ModelsSchema>
      try {
        configuration = ModelsSchema.parse(JSON.parse(canonical))
      } catch {
        throw new GatewayConfigurationError()
      }

      if (modelConfigurationStageIssues(configuration, stage).length > 0) {
        throw new GatewayConfigurationError()
      }
      return configuration
    },
  )

  export const list = fn(z.enum(["lightweight", "full"]), (modelList) => {
    const canonical = [
      Resource.MONGOLGPT_GATEWAY_MODELS1.value,
      Resource.MONGOLGPT_GATEWAY_MODELS2.value,
      Resource.MONGOLGPT_GATEWAY_MODELS3.value,
      Resource.MONGOLGPT_GATEWAY_MODELS4.value,
      Resource.MONGOLGPT_GATEWAY_MODELS5.value,
      Resource.MONGOLGPT_GATEWAY_MODELS6.value,
      Resource.MONGOLGPT_GATEWAY_MODELS7.value,
      Resource.MONGOLGPT_GATEWAY_MODELS8.value,
      Resource.MONGOLGPT_GATEWAY_MODELS9.value,
      Resource.MONGOLGPT_GATEWAY_MODELS10.value,
      Resource.MONGOLGPT_GATEWAY_MODELS11.value,
      Resource.MONGOLGPT_GATEWAY_MODELS12.value,
      Resource.MONGOLGPT_GATEWAY_MODELS13.value,
      Resource.MONGOLGPT_GATEWAY_MODELS14.value,
      Resource.MONGOLGPT_GATEWAY_MODELS15.value,
      Resource.MONGOLGPT_GATEWAY_MODELS16.value,
      Resource.MONGOLGPT_GATEWAY_MODELS17.value,
      Resource.MONGOLGPT_GATEWAY_MODELS18.value,
      Resource.MONGOLGPT_GATEWAY_MODELS19.value,
      Resource.MONGOLGPT_GATEWAY_MODELS20.value,
      Resource.MONGOLGPT_GATEWAY_MODELS21.value,
      Resource.MONGOLGPT_GATEWAY_MODELS22.value,
      Resource.MONGOLGPT_GATEWAY_MODELS23.value,
      Resource.MONGOLGPT_GATEWAY_MODELS24.value,
      Resource.MONGOLGPT_GATEWAY_MODELS25.value,
      Resource.MONGOLGPT_GATEWAY_MODELS26.value,
      Resource.MONGOLGPT_GATEWAY_MODELS27.value,
      Resource.MONGOLGPT_GATEWAY_MODELS28.value,
      Resource.MONGOLGPT_GATEWAY_MODELS29.value,
      Resource.MONGOLGPT_GATEWAY_MODELS30.value,
    ].join("")
    const configuration = parseConfiguration({ canonical, stage: Resource.App.stage })
    const { models, lightweightModels, providers } = configuration
    const compositeProviders = Object.fromEntries(
      Object.entries(providers).map(([id, provider]) => [
        id,
        typeof provider.apiKey === "string"
          ? [{ id: id, key: provider.apiKey }]
          : Object.entries(provider.apiKey).map(([kid, key]) => ({
              id: `${id}.${kid}`,
              key,
            })),
      ]),
    )
    return {
      providers: Object.fromEntries(
        Object.entries(providers).flatMap(([providerId, provider]) =>
          compositeProviders[providerId].map((p) => [p.id, { ...provider, apiKey: p.key }]),
        ),
      ),
      models: (() => {
        return Object.fromEntries(
          Object.entries(modelList === "lightweight" ? lightweightModels : models).map(([modelId, model]) => {
            const n = Array.isArray(model)
              ? model.map((item) => ({ ...item, ...normalizeGatewayModelRoutes(item, compositeProviders) }))
              : { ...model, ...normalizeGatewayModelRoutes(model, compositeProviders) }
            return [modelId, n]
          }),
        )
      })(),
    }
  })
}

export namespace Model {
  export const enable = fn(z.object({ model: z.string() }), ({ model }) => {
    Actor.assertAdmin()
    return Database.use((db) =>
      db.delete(ModelTable).where(and(eq(ModelTable.workspaceID, Actor.workspace()), eq(ModelTable.model, model))),
    )
  })

  export const disable = fn(z.object({ model: z.string() }), ({ model }) => {
    Actor.assertAdmin()
    return Database.use((db) =>
      db
        .insert(ModelTable)
        .values({
          id: Identifier.create("model"),
          workspaceID: Actor.workspace(),
          model: model,
        })
        .onConflictDoUpdate({
          target: [ModelTable.workspaceID, ModelTable.model],
          set: {
            timeDeleted: null,
          },
        }),
    )
  })

  export const listDisabled = fn(z.void(), () => {
    return Database.use((db) =>
      db
        .select({ model: ModelTable.model })
        .from(ModelTable)
        .where(eq(ModelTable.workspaceID, Actor.workspace()))
        .then((rows) => rows.map((row) => row.model)),
    )
  })

  export const isDisabled = fn(
    z.object({
      model: z.string(),
    }),
    ({ model }) => {
      return Database.use(async (db) => {
        const result = await db
          .select()
          .from(ModelTable)
          .where(and(eq(ModelTable.workspaceID, Actor.workspace()), eq(ModelTable.model, model)))
          .limit(1)

        return result.length > 0
      })
    },
  )
}
