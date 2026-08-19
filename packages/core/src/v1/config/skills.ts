export * as ConfigSkillsV1 from "./skills"

import { Schema } from "effect"

export const Info = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Ур чадварын хавтаснуудын нэмэлт замууд",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Ур чадвар татаж авах URL-ууд (жишээ нь: https://example.com/.well-known/skills/)",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
