import { PermissionV1 } from "@mongolgpt/core/v1/permission"
import { Permission } from "@/permission"
import { SessionV1 } from "@mongolgpt/core/v1/session"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { ApiNotFoundError, ModelNotFoundError, PermissionNotFoundError, SessionBusyError } from "../errors"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@mongolgpt/core/provider"
import { ModelV2 } from "@mongolgpt/core/model"

const root = "/session"
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
export const DiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ...Struct.omit(SessionSummary.DiffInput.fields, ["sessionID"]),
})
export const MessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  before: Schema.optional(Schema.String),
})
export const StatusMap = Schema.Record(Schema.String, SessionStatus.Info)
export const UpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Session.Metadata),
  permission: Schema.optional(PermissionV1.Ruleset),
  time: Schema.optional(
    Schema.Struct({
      archived: Schema.optional(Session.ArchivedTimestamp),
    }),
  ),
})
export const ForkPayload = Schema.Struct(Struct.omit(Session.ForkInput.fields, ["sessionID"]))
export const InitPayload = Schema.Struct({
  modelID: ModelV2.ID,
  providerID: ProviderV2.ID,
  messageID: MessageID,
})
export const SummarizePayload = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  auto: Schema.optional(Schema.Boolean),
})
export const PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, ["sessionID"]))
export const CommandPayload = Schema.Struct(Struct.omit(SessionPrompt.CommandInput.fields, ["sessionID"]))
export const ShellPayload = Schema.Struct(Struct.omit(SessionPrompt.ShellInput.fields, ["sessionID"]))
export const RevertPayload = Schema.Struct(Struct.omit(SessionRevert.RevertInput.fields, ["sessionID"]))
export const PermissionResponsePayload = Schema.Struct({
  response: PermissionV1.Reply,
})

export const SessionPaths = {
  list: root,
  status: `${root}/status`,
  get: `${root}/:sessionID`,
  children: `${root}/:sessionID/children`,
  todo: `${root}/:sessionID/todo`,
  diff: `${root}/:sessionID/diff`,
  messages: `${root}/:sessionID/message`,
  message: `${root}/:sessionID/message/:messageID`,
  create: root,
  remove: `${root}/:sessionID`,
  update: `${root}/:sessionID`,
  fork: `${root}/:sessionID/fork`,
  abort: `${root}/:sessionID/abort`,
  share: `${root}/:sessionID/share`,
  init: `${root}/:sessionID/init`,
  summarize: `${root}/:sessionID/summarize`,
  prompt: `${root}/:sessionID/message`,
  promptAsync: `${root}/:sessionID/prompt_async`,
  command: `${root}/:sessionID/command`,
  shell: `${root}/:sessionID/shell`,
  revert: `${root}/:sessionID/revert`,
  unrevert: `${root}/:sessionID/unrevert`,
  permissions: `${root}/:sessionID/permissions/:permissionID`,
  deleteMessage: `${root}/:sessionID/message/:messageID`,
  deletePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  updatePart: `${root}/:sessionID/message/:messageID/part/:partID`,
} as const

export const SessionApi = HttpApi.make("session")
  .add(
    HttpApiGroup.make("session")
      .add(
        HttpApiEndpoint.get("list", SessionPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(Session.Info), "Сессүүдийн жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.list",
            summary: "Сессүүдийг жагсаах",
            description: "Шинэчлэгдсэн хугацаагаар нь эрэмбэлсэн бүх MongolGPT сессийн жагсаалтыг авна.",
          }),
        ),
        HttpApiEndpoint.get("status", SessionPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(StatusMap, "Сессийн төлөв авах"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.status",
            summary: "Сессийн төлөв авах",
            description: "Идэвхтэй, сул болон дууссан төлөвийг багтаасан бүх сессийн одоогийн төлөвийг авна.",
          }),
        ),
        HttpApiEndpoint.get("get", SessionPaths.get, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Сесс авах"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.get",
            summary: "Сесс авах",
            description: "Тодорхой MongolGPT сессийн дэлгэрэнгүй мэдээллийг авна.",
          }),
        ),
        HttpApiEndpoint.get("children", SessionPaths.children, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Session.Info), "Салаалсан сессүүдийн жагсаалт"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.children",
            summary: "Салаалсан сессүүдийг авах",
            description: "Заасан эцэг сессээс салаалсан бүх хүүхэд сессийг авна.",
          }),
        ),
        HttpApiEndpoint.get("todo", SessionPaths.todo, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Todo.Info), "Хийх зүйлсийн жагсаалт"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.todo",
            summary: "Сессийн хийх зүйлсийг авах",
            description: "Тодорхой сесстэй холбоотой, даалгавар болон хийх үйлдлүүдийг харуулсан жагсаалтыг авна.",
          }),
        ),
        HttpApiEndpoint.get("diff", SessionPaths.diff, {
          params: { sessionID: SessionID },
          query: DiffQuery,
          success: described(Schema.Array(Snapshot.FileDiff), "Файлын ялгааг амжилттай авсан"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diff",
            summary: "Мессежийн өөрчлөлтийг авах",
            description: "Сессийн тодорхой хэрэглэгчийн мессежийн үр дүнд гарсан файлын өөрчлөлтийг (diff) авна.",
          }),
        ),
        HttpApiEndpoint.get("messages", SessionPaths.messages, {
          params: { sessionID: SessionID },
          query: MessagesQuery,
          success: described(Schema.Array(SessionV1.WithParts), "Мессежүүдийн жагсаалт"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.messages",
            summary: "Сессийн мессежүүдийг авах",
            description: "Хэрэглэгчийн промпт болон AI-ийн хариуг багтаасан сессийн бүх мессежийг авна.",
          }),
        ),
        HttpApiEndpoint.get("message", SessionPaths.message, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(SessionV1.WithParts, "Мессеж"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.message",
            summary: "Мессеж авах",
            description: "Сессээс мессежийн ID-аар тодорхой мессежийг авна.",
          }),
        ),
        HttpApiEndpoint.post("create", SessionPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Session.CreateInput],
          success: described(Session.Info, "Сессийг амжилттай үүсгэсэн"),
          error: [HttpApiError.BadRequest, ModelNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.create",
            summary: "Сесс үүсгэх",
            description: "AI туслахтай харилцаж, харилцан яриаг удирдах шинэ MongolGPT сесс үүсгэнэ.",
          }),
        ),
        HttpApiEndpoint.delete("remove", SessionPaths.remove, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Сессийг амжилттай устгасан"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.delete",
            summary: "Сесс устгах",
            description: "Сессийг устгаж, мессеж болон түүх зэрэг холбоотой бүх өгөгдлийг бүрмөсөн арилгана.",
          }),
        ),
        HttpApiEndpoint.patch("update", SessionPaths.update, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Session.Info, "Сессийг амжилттай шинэчилсэн"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.update",
            summary: "Сесс шинэчлэх",
            description: "Байгаа сессийн гарчиг болон бусад мета өгөгдөл зэрэг шинжийг шинэчилнэ.",
          }),
        ),
        HttpApiEndpoint.post("fork", SessionPaths.fork, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, ForkPayload],
          success: described(Session.Info, "Салаалсан сесс"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.fork",
            summary: "Сесс салаалуулах",
            description: "Байгаа сессийг тодорхой мессежийн цэг дээр салаалж шинэ сесс үүсгэнэ.",
          }),
        ),
        HttpApiEndpoint.post("abort", SessionPaths.abort, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Сессийг зогсоосон"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.abort",
            summary: "Сесс зогсоох",
            description:
              "Идэвхтэй сессийг зогсоож, үргэлжилж буй AI боловсруулалт эсвэл командын гүйцэтгэлийг дуусгана.",
          }),
        ),
        HttpApiEndpoint.post("init", SessionPaths.init, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: InitPayload,
          success: described(Schema.Boolean, "Сессийг эхлүүлсэн"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ModelNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.init",
            summary: "Сесс эхлүүлэх",
            description:
              "Одоогийн аппликэйшнийг шинжилж, төсөлд зориулсан агентын тохиргоо бүхий AGENTS.md файл үүсгэнэ.",
          }),
        ),
        HttpApiEndpoint.post("share", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Сессийг амжилттай хуваалцсан"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.share",
            summary: "Сесс хуваалцах",
            description: "Бусад хүн харилцан яриаг үзэх боломжтой, сесс хуваалцах холбоос үүсгэнэ.",
          }),
        ),
        HttpApiEndpoint.delete("unshare", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Сессийн хуваалцалтыг амжилттай цуцалсан"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unshare",
            summary: "Сессийн хуваалцалтыг цуцлах",
            description: "Сессийн хуваалцах холбоосыг устгаж, сессийг дахин хувийн болгоно.",
          }),
        ),
        HttpApiEndpoint.post("summarize", SessionPaths.summarize, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SummarizePayload,
          success: described(Schema.Boolean, "Сессийг хураангуйлсан"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ModelNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.summarize",
            summary: "Сессийг хураангуйлах",
            description:
              "Гол мэдээллийг хадгалах зорилгоор AI-ийн хураангуйлах аргыг ашиглан сессийн товч хураангуй үүсгэнэ.",
          }),
        ),
        HttpApiEndpoint.post("prompt", SessionPaths.prompt, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(SessionV1.WithParts, "Мессеж үүссэн"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ModelNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Мессеж илгээх",
            description: "Сесст шинэ мессеж үүсгэж илгээн, AI-ийн хариуг урсгалаар дамжуулна.",
          }),
        ),
        HttpApiEndpoint.post("promptAsync", SessionPaths.promptAsync, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(HttpApiSchema.NoContent, "Промптыг хүлээн авсан"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ModelNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_async",
            summary: "Асинхрон мессеж илгээх",
            description:
              "Сесст асинхроноор шинэ мессеж үүсгэж илгээнэ; шаардлагатай бол сессийг эхлүүлээд шууд буцаана.",
          }),
        ),
        HttpApiEndpoint.post("command", SessionPaths.command, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(SessionV1.WithParts, "Мессеж үүссэн"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ModelNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Команд илгээх",
            description: "AI туслахаар гүйцэтгүүлэх шинэ командыг сесст илгээнэ.",
          }),
        ),
        HttpApiEndpoint.post("shell", SessionPaths.shell, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ShellPayload,
          success: described(SessionV1.WithParts, "Мессеж үүссэн"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ModelNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Shell команд ажиллуулах",
            description: "Сессийн орчинд shell командыг гүйцэтгэж, AI-ийн хариуг буцаана.",
          }),
        ),
        HttpApiEndpoint.post("revert", SessionPaths.revert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: RevertPayload,
          success: described(Session.Info, "Сесс шинэчлэгдсэн"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert",
            summary: "Мессеж буцаах",
            description: "Сессийн тодорхой мессежийг буцааж, нөлөөг нь цуцлан өмнөх төлөвийг сэргээнэ.",
          }),
        ),
        HttpApiEndpoint.post("unrevert", SessionPaths.unrevert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Сесс шинэчлэгдсэн"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unrevert",
            summary: "Буцаасан мессежүүдийг сэргээх",
            description: "Сессэд өмнө нь буцаасан бүх мессежийг сэргээнэ.",
          }),
        ),
        HttpApiEndpoint.post("permissionRespond", SessionPaths.permissions, {
          params: { sessionID: SessionID, permissionID: PermissionV1.ID },
          query: WorkspaceRoutingQuery,
          payload: PermissionResponsePayload,
          success: described(Schema.Boolean, "Зөвшөөрлийг амжилттай боловсруулсан"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.respond",
            summary: "Зөвшөөрлийн хүсэлтэд хариулах",
            description: "AI туслахын зөвшөөрлийн хүсэлтийг зөвшөөрөх эсвэл татгалзана.",
            deprecated: true,
          }),
        ),
        HttpApiEndpoint.delete("deleteMessage", SessionPaths.deleteMessage, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Мессежийг амжилттай устгасан"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.deleteMessage",
            summary: "Мессеж устгах",
            description:
              "Файлын өөрчлөлтийг буцаахгүйгээр тодорхой мессеж болон түүний бүх хэсгийг сессээс бүрмөсөн устгана.",
          }),
        ),
        HttpApiEndpoint.delete("deletePart", SessionPaths.deletePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Хэсгийг амжилттай устгасан"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.delete",
            description: "Мессежээс хэсгийг устгана.",
          }),
        ),
        HttpApiEndpoint.patch("updatePart", SessionPaths.updatePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          payload: SessionV1.Part,
          success: described(SessionV1.Part, "Хэсгийг амжилттай шинэчилсэн"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.update",
            description: "Мессежийн хэсгийг шинэчилнэ.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "Сесс",
          description: "Туршилтын HttpApi сессийн замууд.",
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
      description: "Сонгосон инстансын замуудад зориулсан туршилтын HttpApi интерфейс.",
    }),
  )
