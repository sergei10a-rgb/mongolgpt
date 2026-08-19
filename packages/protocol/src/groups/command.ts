import { Command } from "@mongolgpt/schema/command"
import { Location } from "@mongolgpt/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const CommandGroup = HttpApiGroup.make("server.command")
  .add(
    HttpApiEndpoint.get("command.list", "/api/command", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Command.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.command.list",
          summary: "Командуудыг жагсаах",
          description: "Одоогоор бүртгэлтэй командуудыг авна.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "командууд",
      description: "Туршилтын командын маршрутууд.",
    }),
  )
