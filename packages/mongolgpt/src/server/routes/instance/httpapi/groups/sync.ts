import { NonNegativeInt } from "@mongolgpt/core/schema"
import { EventV2 } from "@mongolgpt/core/event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/sync"
export const ReplayEvent = Schema.Struct({
  id: EventV2.ID,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export const ReplayPayload = Schema.Struct({
  directory: Schema.String,
  events: Schema.NonEmptyArray(ReplayEvent),
})
export const ReplayResponse = Schema.Struct({
  sessionID: Schema.String,
})
export const SessionPayload = Schema.Struct({
  sessionID: SessionID,
})
export const HistoryPayload = Schema.Record(Schema.String, NonNegativeInt)
export const HistoryEvent = Schema.Struct({
  id: EventV2.ID,
  aggregate_id: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})

export const SyncPaths = {
  start: `${root}/start`,
  replay: `${root}/replay`,
  steal: `${root}/steal`,
  history: `${root}/history`,
} as const

export const SyncApi = HttpApi.make("sync")
  .add(
    HttpApiGroup.make("sync")
      .add(
        HttpApiEndpoint.post("start", SyncPaths.start, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Ажлын орчны синхрончлол эхэлсэн"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.start",
            summary: "Ажлын орчны синхрончлол эхлүүлэх",
            description: "Идэвхтэй сесстэй, одоогийн төсөлд буй ажлын орчнуудын синхрончлолын давталтыг эхлүүлнэ.",
          }),
        ),
        HttpApiEndpoint.post("replay", SyncPaths.replay, {
          query: WorkspaceRoutingQuery,
          payload: ReplayPayload,
          success: described(ReplayResponse, "Синхрончлолын үйл явдлыг дахин тоглуулсан"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.replay",
            summary: "Синхрончлолын үйл явдлыг дахин тоглуулах",
            description: "Синхрончлолын үйл явдлын бүрэн түүхийг шалгаж, дахин тоглуулна.",
          }),
        ),
        HttpApiEndpoint.post("steal", SyncPaths.steal, {
          query: WorkspaceRoutingQuery,
          payload: SessionPayload,
          success: described(SessionPayload, "Сессийг ажлын орчинд шилжүүлсэн"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.steal",
            summary: "Сессийг ажлын орчинд шилжүүлэх",
            description: "Синхрончлолын үйл явдлын системээр сессийг одоогийн ажлын орчинд харьяалуулна.",
          }),
        ),
        HttpApiEndpoint.post("history", SyncPaths.history, {
          query: WorkspaceRoutingQuery,
          payload: HistoryPayload,
          success: described(Schema.Array(HistoryEvent), "Синхрончлолын үйл явдлууд"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.history.list",
            summary: "Синхрончлолын үйл явдлуудыг жагсаах",
            description:
              "Бүх агрегатын синхрончлолын үйл явдлыг жагсаана. Түлхүүрүүд нь клиентэд аль хэдийн мэдэгдэж буй агрегатын ID, утгууд нь хамгийн сүүлд мэдэгдэж буй дарааллын ID байна. Тухайн агрегатын seq утга нь value утгаас их байх нөхцөлийг хангасан үйл явдлуудыг буцаана. Оролтод жагсаагдаагүй агрегатын бүрэн түүхийг буцаана.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "Синхрончлол",
          description: "Туршилтын HttpApi синхрончлолын замууд.",
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
