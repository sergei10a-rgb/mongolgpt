import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterEntry } from "@/control-plane/types"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ApiVcsApplyError } from "./instance"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/experimental/workspace"
export const CreatePayload = Schema.Struct(Struct.omit(Workspace.CreateInput.fields, ["projectID"]))
export const WarpPayload = Schema.Struct({
  id: Schema.NullOr(Workspace.Info.fields.id),
  sessionID: Workspace.SessionWarpInput.fields.sessionID,
  copyChanges: Workspace.SessionWarpInput.fields.copyChanges,
})

export class ApiWorkspaceWarpError extends Schema.ErrorClass<ApiWorkspaceWarpError>("WorkspaceWarpError")(
  {
    name: Schema.Literal("WorkspaceWarpError"),
    data: Schema.Struct({
      message: Schema.String.annotate({ description: "Сесс шилжүүлэх үед гарсан алдааны тайлбар" }),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiWorkspaceCreateError extends Schema.ErrorClass<ApiWorkspaceCreateError>("WorkspaceCreateError")(
  {
    name: Schema.Literal("WorkspaceCreateError"),
    data: Schema.Struct({
      message: Schema.String.annotate({ description: "Төслийн хуулбар үүсгэх үед гарсан алдааны тайлбар" }),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const WorkspacePaths = {
  adapters: `${root}/adapter`,
  list: root,
  syncList: `${root}/sync-list`,
  status: `${root}/status`,
  remove: `${root}/:id`,
  warp: `${root}/warp`,
} as const

export const WorkspaceApi = HttpApi.make("workspace")
  .add(
    HttpApiGroup.make("workspace")
      .add(
        HttpApiEndpoint.get("adapters", WorkspacePaths.adapters, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(WorkspaceAdapterEntry), "Ажлын орчны адаптерууд"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.adapter.list",
            summary: "Ажлын орчны адаптеруудыг жагсаах",
            description: "Одоогийн төсөлд ашиглах боломжтой бүх ажлын орчны адаптерийг жагсаана.",
          }),
        ),
        HttpApiEndpoint.get("list", WorkspacePaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workspace.Info), "Ажлын орчнууд"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.list",
            summary: "Ажлын орчнуудыг жагсаах",
            description: "Бүх ажлын орчныг жагсаана.",
          }),
        ),
        HttpApiEndpoint.post("create", WorkspacePaths.list, {
          query: WorkspaceRoutingQuery,
          payload: CreatePayload,
          success: described(Workspace.Info, "Ажлын орчин үүссэн"),
          error: [ApiWorkspaceCreateError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.create",
            summary: "Ажлын орчин үүсгэх",
            description: "Одоогийн төсөлд зориулж ажлын орчин үүсгэнэ.",
          }),
        ),
        HttpApiEndpoint.post("syncList", WorkspacePaths.syncList, {
          query: WorkspaceRoutingQuery,
          success: described(HttpApiSchema.NoContent, "Ажлын орчны жагсаалт синхрончлогдсон"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.syncList",
            summary: "Ажлын орчны жагсаалтыг синхрончлох",
            description: "Ажлын орчны адаптеруудаас ирсэн бүртгэлгүй ажлын орчнуудыг бүртгэнэ.",
          }),
        ),
        HttpApiEndpoint.get("status", WorkspacePaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workspace.ConnectionStatus), "Ажлын орчны төлөв"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.status",
            summary: "Ажлын орчны төлөв",
            description: "Одоогийн төслийн ажлын орчнуудын холболтын төлөвийг авна.",
          }),
        ),
        HttpApiEndpoint.delete("remove", WorkspacePaths.remove, {
          params: { id: Workspace.Info.fields.id },
          query: WorkspaceRoutingQuery,
          success: described(Schema.UndefinedOr(Workspace.Info), "Ажлын орчин устсан"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.remove",
            summary: "Ажлын орчин устгах",
            description: "Байгаа ажлын орчныг устгана.",
          }),
        ),
        HttpApiEndpoint.post("warp", WorkspacePaths.warp, {
          query: WorkspaceRoutingQuery,
          payload: WarpPayload,
          success: described(HttpApiSchema.NoContent, "Сессийг шилжүүлсэн"),
          error: [ApiWorkspaceWarpError, ApiVcsApplyError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.warp",
            summary: "Сессийг ажлын орчинд шилжүүлэх",
            description:
              "Сессийн синхрончлолын түүхийг зорилтот ажлын орчинд шилжүүлэх, эсвэл салгаж локал төсөлд буцаана.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "Төслийн хуулбарын орчин", description: "Туршилтын HttpApi төслийн хуулбарын орчны замууд." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MongolGPT-ийн туршилтын HttpApi",
      version: "0.0.1",
      description: "Сонгосон инстансын замуудад зориулсан туршилтын HttpApi интерфейс.",
    }),
  )
