import { Model } from "@mongolgpt/schema/model"
import { Location } from "@mongolgpt/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ModelGroup = HttpApiGroup.make("server.model")
  .add(
    HttpApiEndpoint.get("model.list", "/api/model", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Model.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.model.list",
          summary: "Моделийн жагсаалт авах",
          description: "Боломжтой моделуудыг гарсан огноогоор нь эрэмбэлэн авна.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "моделууд",
      description: "Туршилтын моделийн маршрутууд.",
    }),
  )
