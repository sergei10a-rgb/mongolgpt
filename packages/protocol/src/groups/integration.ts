import { Integration } from "@mongolgpt/schema/integration"
import { Location } from "@mongolgpt/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const Inputs = Schema.Record(Schema.String, Schema.String)

export const IntegrationGroup = HttpApiGroup.make("server.integration")
  .add(
    HttpApiEndpoint.get("integration.list", "/api/integration", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Integration.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.integration.list",
          summary: "Интеграцын жагсаалт авах",
          description: "Боломжтой интеграцууд болон тэдгээрийн нэвтрэлт танилтын аргуудыг авна.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("integration.get", "/api/integration/:integrationID", {
      params: { integrationID: Integration.ID },
      query: LocationQuery,
      success: Location.response(Schema.UndefinedOr(Integration.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.integration.get",
          summary: "Интеграцын мэдээлэл авах",
          description: "Нэг интеграц болон түүний нэвтрэлт танилтын аргуудыг авна.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("integration.connect.key", "/api/integration/:integrationID/connect/key", {
      params: { integrationID: Integration.ID },
      query: LocationQuery,
      payload: Schema.Struct({
        key: Schema.String,
        label: Schema.optional(Schema.String),
      }),
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.integration.connect.key",
          summary: "Түлхүүрээр холбох",
          description: "Түлхүүрээр нэвтрэлт танилтыг хийж, үүссэн нэвтрэх мэдээллийг хадгална.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("integration.connect.oauth", "/api/integration/:integrationID/connect/oauth", {
      params: { integrationID: Integration.ID },
      query: LocationQuery,
      payload: Schema.Struct({
        methodID: Integration.MethodID,
        inputs: Inputs,
        label: Schema.optional(Schema.String),
      }),
      success: Location.response(Integration.Attempt),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.integration.connect.oauth",
          summary: "OAuth холболт эхлүүлэх",
          description: "OAuth оролдлогыг эхлүүлж, зөвшөөрөл олгоход шаардлагатай мэдээллийг буцаана.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("integration.attempt.status", "/api/integration/attempt/:attemptID", {
      params: { attemptID: Integration.AttemptID },
      query: LocationQuery,
      success: Location.response(Integration.AttemptStatus),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.integration.attempt.status",
          summary: "OAuth оролдлогын төлөв авах",
          description: "OAuth оролдлогын одоогийн төлөвийг шалган буцаана.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("integration.attempt.complete", "/api/integration/attempt/:attemptID/complete", {
      params: { attemptID: Integration.AttemptID },
      query: LocationQuery,
      payload: Schema.Struct({ code: Schema.optional(Schema.String) }),
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.integration.attempt.complete",
          summary: "OAuth холболтыг дуусгах",
          description: "Кодод суурилсан OAuth оролдлогыг дуусгаж, үүссэн нэвтрэх мэдээллийг хадгална.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("integration.attempt.cancel", "/api/integration/attempt/:attemptID", {
      params: { attemptID: Integration.AttemptID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.integration.attempt.cancel",
          summary: "OAuth холболтыг цуцлах",
          description: "OAuth оролдлогыг цуцалж, түүнд ашигласан нөөцийг чөлөөлнө.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "интеграцууд", description: "Интеграц илрүүлэх болон нэвтрэлт танилтын маршрутууд." }),
  )
