import { Provider } from "@mongolgpt/schema/provider"
import { Location } from "@mongolgpt/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProviderNotFoundError, ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ProviderGroup = HttpApiGroup.make("server.provider")
  .add(
    HttpApiEndpoint.get("provider.list", "/api/provider", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Provider.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.list",
          summary: "Провайдеруудын жагсаалт авах",
          description: "Идэвхтэй AI провайдеруудын боломж, тохиргоог клиент шалгахын тулд мэдээллийг нь авна.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("provider.get", "/api/provider/:providerID", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: Location.response(Provider.Info),
      error: [ProviderNotFoundError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.get",
          summary: "Провайдерын мэдээлэл авах",
          description:
            "Нэг AI үйлчилгээ үзүүлэгчийн боломж болон төгсгөлийн цэгийн тохиргоог клиент шалгахын тулд мэдээллийг нь авна.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "провайдерууд",
      description: "Туршилтын провайдерын маршрутууд.",
    }),
  )
