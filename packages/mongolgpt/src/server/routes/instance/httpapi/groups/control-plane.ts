import { MoveSession } from "@mongolgpt/core/control-plane/move-session"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const root = "/experimental/control-plane"
export const MoveSessionPayload = Schema.Struct({ ...MoveSession.Input.fields })

export class ApiMoveSessionError extends Schema.ErrorClass<ApiMoveSessionError>("MoveSessionError")(
  {
    name: Schema.Literal("MoveSessionError"),
    data: Schema.Struct({
      message: Schema.String.annotate({ description: "Сесс зөөх үйлдлийн алдааны тайлбар" }),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const ControlPlaneApi = HttpApi.make("controlPlane").add(
  HttpApiGroup.make("controlPlane")
    .add(
      HttpApiEndpoint.post("moveSession", `${root}/move-session`, {
        payload: MoveSessionPayload,
        success: described(HttpApiSchema.NoContent, "Сессийг зөөвөрлөлөө"),
        error: ApiMoveSessionError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.controlPlane.moveSession",
          summary: "Сесс зөөх",
          description: "Сессийг өөр төслийн лавлах руу зөөж, шаардлагатай бол дотоод өөрчлөлтүүдийг хамт шилжүүлнэ.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "Удирдлагын хавтгайн зохицуулалт", description: "Удирдлагын хавтгайн зохицуулалтын маршрутууд." })),
)
