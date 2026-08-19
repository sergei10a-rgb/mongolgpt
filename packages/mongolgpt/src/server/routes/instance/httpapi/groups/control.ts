import { Auth } from "@/auth"

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { ProviderV2 } from "@mongolgpt/core/provider"

const AuthParams = Schema.Struct({
  providerID: ProviderV2.ID,
})

const LogQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
})

export const LogInput = Schema.Struct({
  service: Schema.String.annotate({ description: "Лог бичлэгийн үйлчилгээний нэр" }),
  level: Schema.Union([
    Schema.Literal("debug"),
    Schema.Literal("info"),
    Schema.Literal("error"),
    Schema.Literal("warn"),
  ]).annotate({ description: "Логийн түвшин" }),
  message: Schema.String.annotate({ description: "Логийн мессеж" }),
  extra: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Лог бичлэгийн нэмэлт мета өгөгдөл",
  }),
})

export const ControlPaths = {
  auth: "/auth/:providerID",
  log: "/log",
} as const

export const ControlApi = HttpApi.make("control").add(
  HttpApiGroup.make("control")
    .add(
      HttpApiEndpoint.put("authSet", ControlPaths.auth, {
        params: AuthParams,
        payload: Auth.Info,
        success: described(Schema.Boolean, "Баталгаажуулалтын мэдээллийг амжилттай тохирууллаа"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.set",
          summary: "Баталгаажуулалтын мэдээлэл тохируулах",
          description: "Баталгаажуулалтын мэдээллийг тохируулна",
        }),
      ),
      HttpApiEndpoint.delete("authRemove", ControlPaths.auth, {
        params: AuthParams,
        success: described(Schema.Boolean, "Баталгаажуулалтын мэдээллийг амжилттай устгалаа"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "auth.remove",
          summary: "Баталгаажуулалтын мэдээлэл устгах",
          description: "Баталгаажуулалтын мэдээллийг устгана",
        }),
      ),
      HttpApiEndpoint.post("log", ControlPaths.log, {
        query: LogQuery,
        payload: LogInput,
        success: described(Schema.Boolean, "Лог бичлэгийг амжилттай үүсгэлээ"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "app.log",
          summary: "Лог бичлэг үүсгэх",
          description: "Заасан түвшин болон мета өгөгдөлтэй лог бичлэгийг серверийн логт үүсгэнэ.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "Удирдлага", description: "Удирдлагын хавтгайн маршрутууд." })),
)
