import { Location } from "@mongolgpt/schema/location"
import { Reference } from "@mongolgpt/schema/reference"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ReferenceGroup = HttpApiGroup.make("server.reference")
  .add(
    HttpApiEndpoint.get("reference.list", "/api/reference", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Reference.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.reference.list",
          summary: "Лавлахуудыг жагсаах",
          description: "Хүссэн байршилд ашиглах боломжтой лавлахуудыг жагсаана.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "лавлахууд",
      description: "Байршлаар хязгаарлагдсан төслийн лавлахууд.",
    }),
  )
