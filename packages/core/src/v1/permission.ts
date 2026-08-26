export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@mongolgpt/schema/permission-v1"
import { ID } from "@mongolgpt/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "Хэрэглэгч энэ хэрэгслийн дуудлагад зөвшөөрөл өгөөгүй."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `Хэрэглэгч энэ хэрэгслийн дуудлагыг дараах тайлбартайгаар зөвшөөрсөнгүй: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `Хэрэглэгч энэ хэрэгслийн дуудлагыг хориглосон дүрэм тохируулсан байна. Холбогдох дүрмүүд: ${JSON.stringify(this.ruleset)}`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError
