import { Schema } from "effect"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

export class MessageDecodeError extends Schema.TaggedErrorClass<MessageDecodeError>()("Session.MessageDecodeError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {
  override get message() {
    return `Сессийн ${this.sessionID} доторх ${this.messageID} мессежийг тайлж чадсангүй`
  }
}

export class ContextSnapshotDecodeError extends Schema.TaggedErrorClass<ContextSnapshotDecodeError>()(
  "Session.ContextSnapshotDecodeError",
  {
    sessionID: SessionSchema.ID,
    details: Schema.String,
  },
) {
  override get message() {
    return `Сессийн ${this.sessionID}-ийн орчны төлөвийн агшныг тайлж чадсангүй: ${this.details}`
  }
}
