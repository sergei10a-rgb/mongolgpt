import { Pty } from "@mongolgpt/schema/pty"
import { PtyTicket } from "@mongolgpt/schema/pty-ticket"
import { Location } from "@mongolgpt/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError, PtyNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const PTY_CONNECT_TICKET_QUERY = "ticket"
export const PTY_CONNECT_TOKEN_HEADER = "x-mongolgpt-ticket"
export const PTY_CONNECT_TOKEN_HEADER_VALUE = "1"

const PTY_CONNECT_PATH = /^\/api\/pty\/[^/]+\/connect$/

// Authorization middleware skips credential checks when this matches; the PTY connect handler
// is then responsible for consuming and validating the ticket.
export function hasPtyConnectTicketURL(url: URL) {
  return PTY_CONNECT_PATH.test(url.pathname) && !!url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
}

export const PtyGroup = HttpApiGroup.make("server.pty")
  .add(
    HttpApiEndpoint.get("pty.list", "/api/pty", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Pty.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.list",
          summary: "PTY сессүүдийн жагсаалт авах",
          description: "Байршлын PTY сессүүдийг жагсааж, дууссан ч устгах хүртэл хадгалагдсан сессүүдийг мөн оруулна.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("pty.create", "/api/pty", {
      query: LocationQuery,
      payload: Pty.CreateInput,
      success: Location.response(Pty.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.create",
          summary: "PTY сесс үүсгэх",
          description: "Байршилд зориулсан псевдо-терминалын сесс үүсгэнэ.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("pty.get", "/api/pty/:ptyID", {
      params: { ptyID: Pty.ID },
      query: LocationQuery,
      success: Location.response(Pty.Info),
      error: PtyNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.get",
          summary: "PTY сессийн мэдээлэл авах",
          description: "Нэг PTY сессийн мэдээллийг авч, дууссан бол гаралтын кодыг нь мөн буцаана.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("pty.update", "/api/pty/:ptyID", {
      params: { ptyID: Pty.ID },
      query: LocationQuery,
      payload: Pty.UpdateInput,
      success: Location.response(Pty.Info),
      error: PtyNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.update",
          summary: "PTY сесс шинэчлэх",
          description: "Нэг PTY сессийн гарчиг эсвэл харах талбарын хэмжээг шинэчилнэ.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("pty.remove", "/api/pty/:ptyID", {
      params: { ptyID: Pty.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: PtyNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.remove",
          summary: "PTY сесс устгах",
          description: "Нэг PTY сессийг дуусгаж, устгана.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("pty.connectToken", "/api/pty/:ptyID/connect-token", {
      params: { ptyID: Pty.ID },
      query: LocationQuery,
      success: Location.response(PtyTicket.ConnectToken),
      error: [ForbiddenError, PtyNotFoundError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.connectToken",
          summary: "PTY WebSocket токен үүсгэх",
          description: "PTY WebSocket холболт нээхэд зориулсан богино хугацаатай, нэг удаагийн тасалбар үүсгэнэ.",
        }),
      ),
  )
  .add(
    // Query fields are decoded in the raw handler after the existence check so a missing
    // session responds with an empty 404 before any upgrade work.
    HttpApiEndpoint.get("pty.connect", "/api/pty/:ptyID/connect", {
      params: { ptyID: Pty.ID },
      success: Schema.Boolean,
      error: [ForbiddenError, PtyNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.pty.connect",
        summary: "PTY сесст холбогдох",
        description: "PTY-ийн гаралтыг дамжуулж, терминалын оролтыг хүлээн авах WebSocket холболт үүсгэнэ.",
        transform: (operation) => ({
          ...operation,
          parameters: [
            ...(operation.parameters ?? []),
            ...["location[directory]", "location[workspace]", "cursor", PTY_CONNECT_TICKET_QUERY].map((name) => ({
              in: "query",
              name,
              schema: { type: "string" },
            })),
          ],
        }),
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "pty", description: "Байршлаар хязгаарлагдсан туршилтын PTY маршрутууд." }))
