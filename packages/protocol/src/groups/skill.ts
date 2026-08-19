import { Skill } from "@mongolgpt/schema/skill"
import { Location } from "@mongolgpt/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Skill.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.list",
          summary: "Ур чадваруудыг жагсаах",
          description: "Одоогоор бүртгэлтэй ур чадваруудыг авна.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "ур чадварууд",
      description: "Туршилтын ур чадварын маршрутууд.",
    }),
  )
