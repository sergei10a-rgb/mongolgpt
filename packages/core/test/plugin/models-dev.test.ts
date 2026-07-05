import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@mongolgpt/core/catalog"
import { Integration } from "@mongolgpt/core/integration"
import { Credential } from "@mongolgpt/core/credential"
import { EventV2 } from "@mongolgpt/core/event"
import { Flag } from "@mongolgpt/core/flag/flag"
import { Location } from "@mongolgpt/core/location"
import { ModelsDev } from "@mongolgpt/core/models-dev"
import { ModelsDevPlugin } from "@mongolgpt/core/plugin/models-dev"
import { Policy } from "@mongolgpt/core/policy"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"

const events = EventV2.defaultLayer
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const policy = Policy.layer.pipe(Layer.provide(locationLayer))
const connections = Credential.defaultLayer.pipe(Layer.fresh)
const integrations = Integration.locationLayer.pipe(Layer.provide(events), Layer.provide(connections))
const catalog = Catalog.layer.pipe(
  Layer.provide(Layer.mergeAll(events, locationLayer, policy, connections, integrations)),
)
const layer = Layer.mergeAll(catalog.pipe(Layer.provide(connections)), integrations, connections, events, locationLayer)
const it = testEffect(layer)

describe("ModelsDevPlugin", () => {
  it.effect("registers key methods for providers with environment variables", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          path: Flag.MONGOLGPT_MODELS_PATH,
          disabled: Flag.MONGOLGPT_DISABLE_MODELS_FETCH,
        }
        Flag.MONGOLGPT_MODELS_PATH = path.join(import.meta.dir, "fixtures", "models-dev.json")
        Flag.MONGOLGPT_DISABLE_MODELS_FETCH = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const catalog = yield* Catalog.Service
          yield* ModelsDevPlugin.effect(
            host({
              catalog: catalogHost(catalog),
              integration: integrationHost(integrations),
            }),
          )
          expect(yield* integrations.list()).toEqual([
            new Integration.Info({
              id: Integration.ID.make("acme"),
              name: "Acme",
              methods: [
                { type: "key" },
                {
                  type: "env",
                  names: ["ACME_API_KEY"],
                },
              ],
              connections: [],
            }),
          ])
        }).pipe(Effect.provide(ModelsDev.defaultLayer)),
      (previous) =>
        Effect.sync(() => {
          Flag.MONGOLGPT_MODELS_PATH = previous.path
          Flag.MONGOLGPT_DISABLE_MODELS_FETCH = previous.disabled
        }),
    ),
  )
})
