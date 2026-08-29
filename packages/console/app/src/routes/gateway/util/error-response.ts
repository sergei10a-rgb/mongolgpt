import {
  AuthError,
  CreditsError,
  FreeUsageLimitError,
  ModelError,
  MonthlyLimitError,
  PlanUsageLimitError,
  QuotaServiceUnavailableError,
  RateLimitError,
  UserLimitError,
} from "./error"
import { GatewayConfigurationError } from "@mongolgpt/console-core/model.js"

function headers(error?: { retryAfter?: number }) {
  const result = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  if (error?.retryAfter) result.set("retry-after", String(error.retryAfter))
  return result
}

function typedError(error: Error, metadata = false) {
  return {
    type: "error",
    error: { type: error.constructor.name, message: error.message },
    ...(metadata ? { metadata: {} } : {}),
  }
}

export function gatewayErrorResponse(error: unknown, internalMessage: string) {
  if (
    error instanceof AuthError ||
    error instanceof CreditsError ||
    error instanceof MonthlyLimitError ||
    error instanceof UserLimitError ||
    error instanceof ModelError
  ) {
    return Response.json(typedError(error), { status: 401, headers: headers() })
  }

  if (error instanceof QuotaServiceUnavailableError) {
    return Response.json(typedError(error, true), { status: 503, headers: headers(error) })
  }

  if (error instanceof GatewayConfigurationError) {
    return Response.json(typedError(error), { status: 424, headers: headers() })
  }

  if (
    error instanceof RateLimitError ||
    error instanceof FreeUsageLimitError ||
    error instanceof PlanUsageLimitError
  ) {
    return Response.json(typedError(error, true), { status: 429, headers: headers(error) })
  }

  return Response.json(
    {
      type: "error",
      error: { type: "error", message: internalMessage },
    },
    { status: 500, headers: headers() },
  )
}
