import { PermissionV1 } from "@mongolgpt/core/v1/permission"
import { Permission } from "@/permission"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { PermissionNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/permission"
const ReplyPayload = Schema.Struct({
  reply: PermissionV1.Reply,
  message: Schema.optional(Schema.String),
})

export const PermissionApi = HttpApi.make("permission")
  .add(
    HttpApiGroup.make("permission")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(PermissionV1.Request), "Хүлээгдэж буй зөвшөөрлүүдийн жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.list",
            summary: "Хүлээгдэж буй зөвшөөрлүүдийг жагсаах",
            description: "Бүх сессийн хүлээгдэж буй зөвшөөрлийн хүсэлтүүдийг авна.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: PermissionV1.ID },
          query: WorkspaceRoutingQuery,
          payload: ReplyPayload,
          success: described(Schema.Boolean, "Зөвшөөрлийг амжилттай боловсруулсан"),
          error: [HttpApiError.BadRequest, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.reply",
            summary: "Зөвшөөрлийн хүсэлтэд хариу өгөх",
            description: "AI туслахаас ирсэн зөвшөөрлийн хүсэлтийг зөвшөөрөх эсвэл татгалзана.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "Зөвшөөрөл",
          description: "Туршилтын HttpApi зөвшөөрлийн замууд.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MongolGPT-ийн туршилтын HttpApi",
      version: "0.0.1",
      description: "Инстансын сонгосон замуудыг хамарсан туршилтын HttpApi интерфейс.",
    }),
  )
