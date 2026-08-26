export * as SkillGuidance from "./guidance"

import { makeLocationNode } from "../effect/node"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SkillV2 } from "../skill"
import { SystemContext } from "../system-context/index"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Ур чадварууд нь тодорхой даалгаварт зориулсан тусгай заавар, ажлын урсгалыг өгнө.",
    "Даалгавар нь тайлбартай нь тохирвол ур чадварын хэрэгслээр тухайн ур чадварыг ачаална уу.",
    ...(skills.length === 0
      ? ["Одоогоор ашиглах ур чадвар алга."]
      : [
          "<available_skills>",
          ...skills.flatMap((skill) => [
            "  <skill>",
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            "  </skill>",
          ]),
          "</available_skills>",
        ]),
  ].join("\n")

export interface Interface {
  readonly load: (agent: AgentV2.Selection) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@mongolgpt/v2/SkillGuidance") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection) {
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const permitted = SkillV2.available(yield* skills.list(), agent)
        if (permitted.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny")
          return SystemContext.empty
        const available = permitted
          .flatMap((skill) =>
            skill.description === undefined ? [] : [{ name: skill.name, description: skill.description }],
          )
          .toSorted((a, b) => a.name.localeCompare(b.name))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            [
              "Ашиглах ур чадварууд өөрчлөгдлөө. Энэ жагсаалт өмнөх жагсаалтыг орлоно.",
              render(current),
            ].join("\n"),
          removed: () => "Ур чадварын заавар цаашид ашиглах боломжгүй. Өмнө жагсаасан ур чадварыг бүү ашигла.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node] })
