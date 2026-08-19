import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { QuestionNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/question"
const ReplyPayload = Schema.Struct({
  answers: Schema.Array(Question.Answer).annotate({
    description: "Асуултуудын дарааллын дагуух хэрэглэгчийн хариултууд (хариулт бүр нь сонгосон шошгуудын массив байна)",
  }),
})

export const QuestionApi = HttpApi.make("question")
  .add(
    HttpApiGroup.make("question")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Question.Request), "Хүлээгдэж буй асуултуудын жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.list",
            summary: "Хүлээгдэж буй асуултуудыг жагсаах",
            description: "Бүх сессийн хүлээгдэж буй асуултын хүсэлтүүдийг авна.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: QuestionID },
          query: WorkspaceRoutingQuery,
          payload: ReplyPayload,
          success: described(Schema.Boolean, "Асуултад амжилттай хариулсан"),
          error: [HttpApiError.BadRequest, QuestionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reply",
            summary: "Асуултын хүсэлтэд хариулах",
            description: "AI туслахын асуултын хүсэлтэд хариулт өгнө.",
          }),
        ),
        HttpApiEndpoint.post("reject", `${root}/:requestID/reject`, {
          params: { requestID: QuestionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Асуултыг амжилттай татгалзсан"),
          error: [HttpApiError.BadRequest, QuestionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reject",
            summary: "Асуултын хүсэлтээс татгалзах",
            description: "AI туслахын асуултын хүсэлтээс татгалзана.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "Асуулт",
          description: "Асуултын замууд.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MongolGPT HttpApi",
      version: "0.0.1",
      description: "Инстансын замуудад зориулсан Effect HttpApi интерфейс.",
    }),
  )
