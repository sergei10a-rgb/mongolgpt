export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { Global } from "../global"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const environment = [
      "<env>",
      `  Ажиллаж буй хавтас: ${location.directory}`,
      `  Ажлын орчны үндсэн хавтас: ${location.project.directory}`,
      `  Хавтас нь git репозитор мөн үү: ${location.vcs?.type === "git" ? "yes" : "no"}`,
      `  Платформ: ${process.platform}`,
      "</env>",
    ].join("\n")
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(environment),
        baseline: (environment) =>
          ["Таны ажиллаж буй орчны хэрэгтэй мэдээлэл:", environment].join("\n"),
        update: (_previous, environment) => ["Таны ажиллаж буй орчин одоо:", environment].join("\n"),
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/date"),
        codec: Schema.toCodecJson(Schema.String),
        load: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
        baseline: (date) => `Өнөөдрийн огноо: ${date}`,
        update: (_previous, date) => `Өнөөдрийн огноо одоо: ${date}`,
      }),
    ])

    yield* registry.register({ key: SystemContext.Key.make("core/builtins"), load: Effect.succeed(context) })
  }),
)

export const layer = Layer.mergeAll(builtIns, InstructionContext.layer).pipe(
  Layer.provideMerge(SystemContextRegistry.layer),
)

export const locationLayer = layer

export const node = makeLocationNode({
  name: "system-context-builtins",
  layer,
  deps: [Location.node, SystemContextRegistry.node, InstructionContext.node, FSUtil.node, Global.node],
})
