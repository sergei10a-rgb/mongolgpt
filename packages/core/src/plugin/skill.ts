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
              "ЗӨВХӨН хэрэглэгч MongolGPT-ийн өөрийн тохиргоо болох mongolgpt.json, mongolgpt.jsonc, .mongolgpt/ доторх файл эсвэл ~/.config/mongolgpt/ доторх файлыг үүсгэх, засах үед ашиглана. Мөн MongolGPT-ийн agent, subagent, command, skill, plugin, MCP server эсвэл permission дүрмийг үүсгэх, засах үед ашиглана. Хэрэглэгчийн өөрийн application code болон MongolGPT-ийг тохируулахтай холбоогүй төсөлд бүү ашигла.",
            location: AbsolutePath.make("/builtin/customize-mongolgpt.md"),
            content: CustomizeMongolGPTContent,
          }),
        }),
      )
    })
  }),
})
