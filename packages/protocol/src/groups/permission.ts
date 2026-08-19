import { Agent } from "@mongolgpt/schema/agent"
import { Location } from "@mongolgpt/schema/location"
import { Permission } from "@mongolgpt/schema/permission"
import { PermissionSaved } from "@mongolgpt/schema/permission-saved"
import { Project } from "@mongolgpt/schema/project"
import { Session } from "@mongolgpt/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { PermissionNotFoundError, SessionNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const makePermissionGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.permission")
    .add(
      HttpApiEndpoint.get("permission.request.list", "/api/permission/request", {
        query: LocationQuery,
        success: Location.response(Schema.Array(Permission.Request)),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.permission.request.list",
            summary: "Хүлээгдэж буй зөвшөөрлийн хүсэлтүүдийг жагсаах",
            description: "Тухайн байршилд хүлээгдэж буй зөвшөөрлийн хүсэлтүүдийг авна.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("permission.saved.list", "/api/permission/saved", {
        query: Schema.Struct({ projectID: Project.ID.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Schema.Array(PermissionSaved.Info) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.saved.list",
          summary: "Хадгалсан зөвшөөрлүүдийг жагсаах",
          description: "Хадгалсан зөвшөөрлүүдийг авна. Төслөөр шүүж болно.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("permission.saved.remove", "/api/permission/saved/:id", {
        params: { id: PermissionSaved.ID },
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.saved.remove",
          summary: "Хадгалсан зөвшөөрлийг устгах",
          description: "ID-аар заасан хадгалсан зөвшөөрлийг устгана.",
        }),
      ),
    )
    // Effect applies group middleware only to endpoints already added; session endpoints use session placement below.
    .middleware(locationMiddleware)
    .add(
      HttpApiEndpoint.post("session.permission.create", "/api/session/:sessionID/permission", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Permission.ID.pipe(Schema.optional),
          action: Permission.Request.fields.action,
          resources: Permission.Request.fields.resources,
          save: Permission.Request.fields.save,
          metadata: Permission.Request.fields.metadata,
          source: Permission.Request.fields.source,
          agent: Agent.ID.pipe(Schema.optional),
        }),
        success: Schema.Struct({
          data: Schema.Struct({ id: Permission.ID, effect: Permission.Effect }),
        }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.create",
            summary: "Зөвшөөрлийн хүсэлт үүсгэх",
            description: "Үнэлгээ хийж, зөвшөөрөл шаардлагатай бол тухайн сесст зөвшөөрлийн хүсэлт үүсгэнэ.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.list", "/api/session/:sessionID/permission", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(Permission.Request) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.list",
            summary: "Сессийн зөвшөөрлийн хүсэлтүүдийг жагсаах",
            description: "Тухайн сесст хамаарах хүлээгдэж буй зөвшөөрлийн хүсэлтүүдийг авна.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.get", "/api/session/:sessionID/permission/:requestID", {
        params: { sessionID: Session.ID, requestID: Permission.ID },
        success: Schema.Struct({ data: Permission.Request }),
        error: [SessionNotFoundError, PermissionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.get",
            summary: "Зөвшөөрлийн хүсэлт авах",
            description: "Тухайн сесст хамаарах хүлээгдэж буй зөвшөөрлийн хүсэлтийг авна.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.permission.reply", "/api/session/:sessionID/permission/:requestID/reply", {
        params: { sessionID: Session.ID, requestID: Permission.ID },
        payload: Schema.Struct({
          reply: Permission.Reply,
          message: Schema.String.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, PermissionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.reply",
            summary: "Хүлээгдэж буй зөвшөөрлийн хүсэлтэд хариулах",
            description: "Тухайн сесст хамаарах хүлээгдэж буй зөвшөөрлийн хүсэлтэд хариулна.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "зөвшөөрлүүд", description: "Туршилтын зөвшөөрлийн маршрутууд." }))
