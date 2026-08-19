import { Session } from "@mongolgpt/schema/session"
import { SessionMessage } from "@mongolgpt/schema/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidCursorError, SessionNotFoundError, UnknownError } from "../errors"

export const SessionMessagesQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "Буцаах мессежийн дээд тоо. Заагаагүй бол энэ төгсгөлийн цэг өгөгдмөл хуудасны хэмжээг ашиглана.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Эхний хуудасны мессежийн дараалал. Шинээс нь эхлүүлэх бол desc, хуучнаас нь эхлүүлэх бол asc ашиглана.",
  }),
  cursor: Schema.optional(
    Schema.String.annotate({
      description:
        "Өмнөх хариунд cursor.previous эсвэл cursor.next хэлбэрээр буцсан, доторх утга нь ил биш хуудаслалтын заагч. Үүнийг order параметртэй хамт ашиглаж болохгүй.",
    }),
  ),
}).annotate({ identifier: "SessionMessagesQuery" })

export const MessageGroup = HttpApiGroup.make("server.message")
  .add(
    HttpApiEndpoint.get("session.messages", "/api/session/:sessionID/message", {
      params: { sessionID: Session.ID },
      query: SessionMessagesQuery,
      success: Schema.Struct({
        data: Schema.Array(SessionMessage.Message),
        cursor: Schema.Struct({
          previous: Schema.String.pipe(Schema.optional),
          next: Schema.String.pipe(Schema.optional),
        }),
      }).annotate({ identifier: "SessionMessagesResponse" }),
      error: [InvalidCursorError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.messages",
        summary: "Сессийн мессежүүдийг авах",
        description:
          "Сессийн проекцолсон мессежүүдийг авна. Зүйлс хуудсуудын хооронд хүссэн дарааллаа хадгална; эрэмбэлэгдсэн дарааллаар шилжихдээ cursor.next эсвэл cursor.previous ашиглана.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "мессежүүд",
      description: "Туршилтын мессежийн маршрутууд.",
    }),
  )
