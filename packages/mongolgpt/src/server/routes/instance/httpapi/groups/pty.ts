import { Pty } from "@mongolgpt/core/pty"
import { PtyTicket } from "@mongolgpt/core/pty/ticket"
import { PtyID } from "@mongolgpt/core/pty/schema"
import { PTY_CONNECT_TICKET_QUERY } from "@/server/shared/pty-ticket"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization, PtyConnectAuthorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { PtyForbiddenError, PtyNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/pty"
export const Params = Schema.Struct({ ptyID: PtyID })
export const CursorQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  cursor: Schema.optional(Schema.String),
})
export const ShellItem = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  acceptable: Schema.Boolean,
})

export const PtyPaths = {
  shells: `${root}/shells`,
  list: root,
  create: root,
  get: `${root}/:ptyID`,
  update: `${root}/:ptyID`,
  remove: `${root}/:ptyID`,
  connectToken: `${root}/:ptyID/connect-token`,
  connect: `${root}/:ptyID/connect`,
} as const

export const PtyApi = HttpApi.make("pty")
  .add(
    HttpApiGroup.make("pty")
      .add(
        HttpApiEndpoint.get("shells", PtyPaths.shells, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(ShellItem), "Shell-үүдийн жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.shells",
            summary: "Боломжтой shell-үүдийг жагсаах",
            description: "Системд ашиглах боломжтой shell-үүдийн жагсаалтыг авна.",
          }),
        ),
        HttpApiEndpoint.get("list", PtyPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Pty.Info), "Сессүүдийн жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.list",
            summary: "PTY сессүүдийг жагсаах",
            description: "MongolGPT-ийн удирддаг бүх идэвхтэй псевдо-терминалын (PTY) сессийн жагсаалтыг авна.",
          }),
        ),
        HttpApiEndpoint.post("create", PtyPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: Pty.CreateInput,
          success: described(Pty.Info, "Сесс үүссэн"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.create",
            summary: "PTY сесс үүсгэх",
            description: "Shell команд болон процесс ажиллуулах шинэ псевдо-терминалын (PTY) сесс үүсгэнэ.",
          }),
        ),
        HttpApiEndpoint.get("get", PtyPaths.get, {
          params: { ptyID: PtyID },
          query: WorkspaceRoutingQuery,
          success: described(Pty.Info, "Сессийн мэдээлэл"),
          error: PtyNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.get",
            summary: "PTY сесс авах",
            description: "Тодорхой псевдо-терминалын (PTY) сессийн дэлгэрэнгүй мэдээллийг авна.",
          }),
        ),
        HttpApiEndpoint.put("update", PtyPaths.update, {
          params: { ptyID: PtyID },
          query: WorkspaceRoutingQuery,
          payload: Pty.UpdateInput,
          success: described(Pty.Info, "Сесс шинэчлэгдсэн"),
          error: [PtyNotFoundError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.update",
            summary: "PTY сесс шинэчлэх",
            description: "Байгаа псевдо-терминалын (PTY) сессийн шинжүүдийг шинэчилнэ.",
          }),
        ),
        HttpApiEndpoint.delete("remove", PtyPaths.remove, {
          params: { ptyID: PtyID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Сесс устсан"),
          error: PtyNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.remove",
            summary: "PTY сесс устгах",
            description: "Тодорхой псевдо-терминалын (PTY) сессийг устгаж, дуусгана.",
          }),
        ),
        HttpApiEndpoint.post("connectToken", PtyPaths.connectToken, {
          params: { ptyID: PtyID },
          query: WorkspaceRoutingQuery,
          success: described(PtyTicket.ConnectToken, "WebSocket холболтын токен"),
          error: [PtyForbiddenError, PtyNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.connectToken",
            summary: "PTY WebSocket токен үүсгэх",
            description: "PTY WebSocket холболт нээх богино хугацааны тасалбар үүсгэнэ.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "Псевдо-терминал", description: "Туршилтын HttpApi PTY замууд." }))
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

export const PtyConnectApi = HttpApi.make("pty-connect").add(
  HttpApiGroup.make("pty-connect")
    .add(
      // Decode PTY connection query fields in the raw handler after checking
      // existence, preserving the established empty-404 response ordering.
      HttpApiEndpoint.get("connect", PtyPaths.connect, {
        params: Params,
        success: described(Schema.Boolean, "Сесс холбогдсон"),
        error: [HttpApiError.Forbidden, HttpApiError.NotFound],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pty.connect",
          summary: "PTY сесст холбогдох",
          description:
            "Псевдо-терминалын (PTY) сесстэй бодит цагт харилцах WebSocket холболт үүсгэнэ.",
          transform: (operation) => ({
            ...operation,
            parameters: [
              ...(operation.parameters ?? []),
              ...["directory", "workspace", "cursor", PTY_CONNECT_TICKET_QUERY].map((name) => ({
                in: "query",
                name,
                schema: { type: "string" },
              })),
            ],
          }),
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "Псевдо-терминалын WebSocket", description: "PTY WebSocket зам." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(PtyConnectAuthorization),
)
