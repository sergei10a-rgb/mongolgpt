import { Question } from "@mongolgpt/schema/question"
import { Location } from "@mongolgpt/schema/location"
import { Session } from "@mongolgpt/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { QuestionNotFoundError, SessionNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const makeQuestionGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.question")
    .add(
      HttpApiEndpoint.get("question.request.list", "/api/question/request", {
        query: LocationQuery,
        success: Location.response(Schema.Array(Question.Request)),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.question.request.list",
            summary: "Хүлээгдэж буй асуултын хүсэлтүүдийг жагсаах",
            description: "Тухайн байршилд хүлээгдэж буй асуултын хүсэлтүүдийг авна.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "асуултууд", description: "Туршилтын асуултын маршрутууд." }))
    // Effect applies group middleware only to endpoints already added; session endpoints use session placement below.
    .middleware(locationMiddleware)
    .add(
      HttpApiEndpoint.get("session.question.list", "/api/session/:sessionID/question", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(Question.Request) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.question.list",
            summary: "Сессийн асуултын хүсэлтүүдийг жагсаах",
            description: "Тухайн сесст хамаарах хүлээгдэж буй асуултын хүсэлтүүдийг авна.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.question.reply", "/api/session/:sessionID/question/:requestID/reply", {
        params: { sessionID: Session.ID, requestID: Question.ID },
        payload: Question.Reply,
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, QuestionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.question.reply",
            summary: "Хүлээгдэж буй асуултын хүсэлтэд хариулах",
            description: "Тухайн сесст хамаарах хүлээгдэж буй асуултын хүсэлтэд хариулна.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.question.reject", "/api/session/:sessionID/question/:requestID/reject", {
        params: { sessionID: Session.ID, requestID: Question.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, QuestionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.question.reject",
            summary: "Хүлээгдэж буй асуултын хүсэлтийг татгалзах",
            description: "Тухайн сесст хамаарах хүлээгдэж буй асуултын хүсэлтийг татгалзана.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "сессийн асуултууд", description: "Туршилтын сессийн асуултын маршрутууд." }),
    )
