import { RequestError } from "@agentclientprotocol/sdk"
import { Schema } from "effect"

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()("ACPSessionNotFoundError", {
  sessionId: Schema.String,
}) {}

export class InvalidConfigOptionError extends Schema.TaggedErrorClass<InvalidConfigOptionError>()(
  "ACPInvalidConfigOptionError",
  {
    configId: Schema.String,
  },
) {}

export class InvalidModelError extends Schema.TaggedErrorClass<InvalidModelError>()("ACPInvalidModelError", {
  modelId: Schema.String,
  providerId: Schema.optional(Schema.String),
}) {}

export class InvalidEffortError extends Schema.TaggedErrorClass<InvalidEffortError>()("ACPInvalidEffortError", {
  effort: Schema.String,
}) {}

export class InvalidModeError extends Schema.TaggedErrorClass<InvalidModeError>()("ACPInvalidModeError", {
  mode: Schema.String,
}) {}

export class AuthRequiredError extends Schema.TaggedErrorClass<AuthRequiredError>()("ACPAuthRequiredError", {
  providerId: Schema.optional(Schema.String),
}) {}

export class UnknownAuthMethodError extends Schema.TaggedErrorClass<UnknownAuthMethodError>()(
  "ACPUnknownAuthMethodError",
  {
    methodId: Schema.String,
  },
) {}

export class UnsupportedOperationError extends Schema.TaggedErrorClass<UnsupportedOperationError>()(
  "ACPUnsupportedOperationError",
  {
    method: Schema.String,
  },
) {}

export class ServiceFailureError extends Schema.TaggedErrorClass<ServiceFailureError>()("ACPServiceFailureError", {
  safeMessage: Schema.String,
  service: Schema.optional(Schema.String),
  errorName: Schema.optional(Schema.String),
}) {}

export type Error =
  | SessionNotFoundError
  | InvalidConfigOptionError
  | InvalidModelError
  | InvalidEffortError
  | InvalidModeError
  | AuthRequiredError
  | UnknownAuthMethodError
  | UnsupportedOperationError
  | ServiceFailureError

export function toRequestError(error: Error) {
  switch (error._tag) {
    case "ACPSessionNotFoundError":
      return new RequestError(-32602, `Сесс олдсонгүй: ${error.sessionId}`, { sessionId: error.sessionId })
    case "ACPInvalidConfigOptionError":
      return new RequestError(-32602, `Тохиргооны сонголт танигдсангүй: ${error.configId}`, {
        configId: error.configId,
      })
    case "ACPInvalidModelError":
      return new RequestError(-32602, `Загвар олдсонгүй: ${error.modelId}`, {
        providerId: error.providerId,
        modelId: error.modelId,
      })
    case "ACPInvalidEffortError":
      return new RequestError(-32602, `Чармайлтын түвшин танигдсангүй: ${error.effort}`, { effort: error.effort })
    case "ACPInvalidModeError":
      return new RequestError(-32602, `Горим танигдсангүй: ${error.mode}`, { mode: error.mode })
    case "ACPAuthRequiredError":
      return new RequestError(-32000, "Үйлчилгээ үзүүлэгчид нэвтрэх шаардлагатай", {
        providerId: error.providerId,
      })
    case "ACPUnknownAuthMethodError":
      return new RequestError(-32602, `Нэвтрэх арга танигдсангүй: ${error.methodId}`, {
        methodId: error.methodId,
      })
    case "ACPUnsupportedOperationError":
      return new RequestError(-32601, `Үйлдэл олдсонгүй: ${error.method}`, { method: error.method })
    case "ACPServiceFailureError":
      return new RequestError(-32603, `Дотоод алдаа: ${error.safeMessage}`, {
        ...(error.service ? { service: error.service } : {}),
        ...(error.errorName ? { errorName: error.errorName } : {}),
      })
    default: {
      const exhaustive: never = error
      return exhaustive
    }
  }
}

export function fromUnknownDefect(_defect: unknown, safeMessage = "Дотоод үйлчилгээний алдаа гарлаа") {
  return new ServiceFailureError({ safeMessage })
}
