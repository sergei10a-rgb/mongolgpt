import { EventV2 } from "@mongolgpt/core/event"
import { NamedError } from "@mongolgpt/core/util/error"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

export const historyLayer = HttpRouter.middleware<{ requires: EventV2.Service; handles: unknown }>()(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const unavailable = () =>
      HttpServerResponse.jsonUnsafe(
        new NamedError.Unknown({
          message: "Cloud түүхийн хадгалалт бэлэн биш байна. Түр хүлээгээд дахин оролдоно уу.",
        }).toObject(),
        { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
      )
    return (effect) =>
      events.check.pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(unavailable())),
          onSuccess: () =>
            effect.pipe(
              Effect.flatMap((response) =>
                events.check.pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) =>
                      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(unavailable()),
                    onSuccess: () => Effect.succeed(response),
                  }),
                ),
              ),
            ),
        }),
      )
  }),
).layer
