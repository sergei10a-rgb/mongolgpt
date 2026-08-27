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

export namespace GatewayCatalog {
  export type Format = ModelFormat
  const ModelsSchema = MongolGPTModelConfigurationSchema

  export const validate = fn(ModelsSchema, (input) => {
    return input
  })

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
    const json = JSON.parse(canonical)
    const configuration = ModelsSchema.parse(json)
    const policyIssues = modelConfigurationStageIssues(configuration, Resource.App.stage)
    if (policyIssues.length > 0) {
      throw new Error(`Үйлдвэрлэлийн загварын тохиргоо аюулгүй биш байна: ${policyIssues.join("; ")}`)
    }
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
        const normalize = (model: z.infer<typeof MongolGPTModelSchema>) => {
          const providers = model.providers.map((p) => ({
            ...p,
            priority: p.priority ?? Infinity,
            weight: p.weight ?? 1,
          }))
          const composite = providers.find((p) => compositeProviders[p.id].length > 1)
          if (!composite)
            return {
              trialProvider: model.trialProvider ? [model.trialProvider] : undefined,
              providers,
            }

          const weightMulti = compositeProviders[composite.id].length

          return {
            trialProvider: (() => {
              if (!model.trialProvider) return undefined
              if (model.trialProvider === composite.id) return compositeProviders[composite.id].map((p) => p.id)
              return [model.trialProvider]
            })(),
            providers: providers.flatMap((p) =>
              p.id === composite.id
                ? compositeProviders[p.id].map((sub) => ({
                    ...p,
                    id: sub.id,
                  }))
                : [
                    {
                      ...p,
                      weight: p.weight * weightMulti,
                    },
                  ],
            ),
          }
        }

        return Object.fromEntries(
          Object.entries(modelList === "lightweight" ? lightweightModels : models).map(([modelId, model]) => {
            const n = Array.isArray(model)
              ? model.map((m) => ({ ...m, ...normalize(m) }))
              : { ...model, ...normalize(model) }
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
