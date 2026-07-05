/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeMongolGPTContent from "./skill/customize-mongolgpt.md" with { type: "text" }

export const CustomizeMongolGPTContent = customizeMongolGPTContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-mongolgpt",
            description:
              "Use ONLY when the user is editing or creating MongolGPT's own configuration: mongolgpt.json, mongolgpt.jsonc, files under .mongolgpt/, or files under ~/.config/mongolgpt/. Also use when creating or fixing MongolGPT agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring MongolGPT itself.",
            location: AbsolutePath.make("/builtin/customize-mongolgpt.md"),
            content: CustomizeMongolGPTContent,
          }),
        }),
      )
    })
  }),
})
