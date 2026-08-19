import { TuiEvent } from "@/server/tui-event"
import { TuiRequest as TuiRequestPayload } from "@/server/shared/tui-control"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/tui"
export const CommandPayload = Schema.Struct({ command: Schema.String })
const EventTuiPromptAppend = Schema.Struct({
  type: Schema.Literal(TuiEvent.PromptAppend.type),
  properties: TuiEvent.PromptAppend.data,
}).annotate({ identifier: "EventTuiPromptAppend" })
const EventTuiCommandExecute = Schema.Struct({
  type: Schema.Literal(TuiEvent.CommandExecute.type),
  properties: TuiEvent.CommandExecute.data,
}).annotate({ identifier: "EventTuiCommandExecute" })
const EventTuiToastShow = Schema.Struct({
  type: Schema.Literal(TuiEvent.ToastShow.type),
  properties: TuiEvent.ToastShow.data,
}).annotate({ identifier: "EventTuiToastShow" })
const EventTuiSessionSelect = Schema.Struct({
  type: Schema.Literal(TuiEvent.SessionSelect.type),
  properties: TuiEvent.SessionSelect.data,
}).annotate({ identifier: "EventTuiSessionSelect" })
export const TuiPublishPayload = Schema.Union([
  EventTuiPromptAppend,
  EventTuiCommandExecute,
  EventTuiToastShow,
  EventTuiSessionSelect,
])

export const TuiPaths = {
  appendPrompt: `${root}/append-prompt`,
  openHelp: `${root}/open-help`,
  openSessions: `${root}/open-sessions`,
  openThemes: `${root}/open-themes`,
  openModels: `${root}/open-models`,
  submitPrompt: `${root}/submit-prompt`,
  clearPrompt: `${root}/clear-prompt`,
  executeCommand: `${root}/execute-command`,
  showToast: `${root}/show-toast`,
  publish: `${root}/publish`,
  selectSession: `${root}/select-session`,
  controlNext: `${root}/control/next`,
  controlResponse: `${root}/control/response`,
} as const

export const TuiApi = HttpApi.make("tui")
  .add(
    HttpApiGroup.make("tui")
      .add(
        HttpApiEndpoint.post("appendPrompt", TuiPaths.appendPrompt, {
          query: WorkspaceRoutingQuery,
          payload: TuiEvent.PromptAppend.data,
          success: described(Schema.Boolean, "Промптыг амжилттай боловсруулсан"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.appendPrompt",
            summary: "TUI промпт нэмэх",
            description: "TUI-д промпт нэмнэ.",
          }),
        ),
        HttpApiEndpoint.post("openHelp", TuiPaths.openHelp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Тусламжийн цонхыг амжилттай нээсэн"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openHelp",
            summary: "Тусламжийн цонх нээх",
            description: "Хэрэглэгчид туслах мэдээллийг харуулахын тулд TUI дахь тусламжийн цонхыг нээнэ.",
          }),
        ),
        HttpApiEndpoint.post("openSessions", TuiPaths.openSessions, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Сессийн цонхыг амжилттай нээсэн"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openSessions",
            summary: "Сессийн цонх нээх",
            description: "Сессийн цонхыг нээнэ.",
          }),
        ),
        HttpApiEndpoint.post("openThemes", TuiPaths.openThemes, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Загварын цонхыг амжилттай нээсэн"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openThemes",
            summary: "Загварын цонх нээх",
            description: "Загварын цонхыг нээнэ.",
          }),
        ),
        HttpApiEndpoint.post("openModels", TuiPaths.openModels, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Моделийн цонхыг амжилттай нээсэн"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openModels",
            summary: "Моделийн цонх нээх",
            description: "Моделийн цонхыг нээнэ.",
          }),
        ),
        HttpApiEndpoint.post("submitPrompt", TuiPaths.submitPrompt, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Промптыг амжилттай илгээсэн"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.submitPrompt",
            summary: "TUI промпт илгээх",
            description: "Промптыг илгээнэ.",
          }),
        ),
        HttpApiEndpoint.post("clearPrompt", TuiPaths.clearPrompt, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Промптыг амжилттай цэвэрлэсэн"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.clearPrompt",
            summary: "TUI промпт цэвэрлэх",
            description: "Промптыг цэвэрлэнэ.",
          }),
        ),
        HttpApiEndpoint.post("executeCommand", TuiPaths.executeCommand, {
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(Schema.Boolean, "Командыг амжилттай гүйцэтгэсэн"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.executeCommand",
            summary: "TUI команд гүйцэтгэх",
            description: "TUI командыг гүйцэтгэнэ.",
          }),
        ),
        HttpApiEndpoint.post("showToast", TuiPaths.showToast, {
          query: WorkspaceRoutingQuery,
          payload: TuiEvent.ToastShow.data,
          success: described(Schema.Boolean, "Toast мэдэгдлийг амжилттай харуулсан"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.showToast",
            summary: "TUI toast харуулах",
            description: "TUI-д toast мэдэгдэл харуулна.",
          }),
        ),
        HttpApiEndpoint.post("publish", TuiPaths.publish, {
          query: WorkspaceRoutingQuery,
          payload: TuiPublishPayload,
          success: described(Schema.Boolean, "Үйл явдлыг амжилттай нийтэлсэн"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.publish",
            summary: "TUI үйл явдал нийтлэх",
            description: "TUI үйл явдал нийтэлнэ.",
          }),
        ),
        HttpApiEndpoint.post("selectSession", TuiPaths.selectSession, {
          query: WorkspaceRoutingQuery,
          payload: TuiEvent.SessionSelect.data,
          success: described(Schema.Boolean, "Сессийг амжилттай сонгосон"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.selectSession",
            summary: "Сесс сонгох",
            description: "Заасан сессийг харуулахаар TUI-г шилжүүлнэ.",
          }),
        ),
        HttpApiEndpoint.get("controlNext", TuiPaths.controlNext, {
          query: WorkspaceRoutingQuery,
          success: described(TuiRequestPayload, "Дараагийн TUI хүсэлт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.control.next",
            summary: "Дараагийн TUI хүсэлтийг авах",
            description: "Боловсруулах дараагийн TUI хүсэлтийг дарааллаас авна.",
          }),
        ),
        HttpApiEndpoint.post("controlResponse", TuiPaths.controlResponse, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Unknown,
          success: described(Schema.Boolean, "Хариуг амжилттай илгээсэн"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.control.response",
            summary: "TUI-д хариу илгээх",
            description: "Хүлээгдэж буй хүсэлтийг дуусгахын тулд TUI хүсэлтийн дараалалд хариу илгээнэ.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "Терминалын интерфейс", description: "Туршилтын HttpApi TUI замууд." }))
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
