import { MoveSession } from "@mongolgpt/core/control-plane/move-session"
import { SessionV2 } from "@mongolgpt/core/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { ApiMoveSessionError, MoveSessionPayload } from "../groups/control-plane"

export const controlPlaneHandlers = HttpApiBuilder.group(RootHttpApi, "controlPlane", (handlers) =>
  Effect.gen(function* () {
    const service = yield* MoveSession.Service

    const moveSession = Effect.fn("ControlPlaneHttpApi.moveSession")(function* (ctx: {
      payload: typeof MoveSessionPayload.Type
    }) {
      yield* service.moveSession(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiMoveSessionError({
              name: "MoveSessionError",
              data: { message: moveSessionErrorMessage(error) },
            }),
        ),
      )
    })

    return handlers.handle("moveSession", moveSession)
  }),
)

export function moveSessionErrorMessage(error: MoveSession.Error) {
  if (error instanceof SessionV2.NotFoundError) return `Сесс олдсонгүй: ${error.sessionID}`
  if (error instanceof MoveSession.DestinationProjectMismatchError)
    return "Очих хавтас өөр төсөлд харьяалагдаж байна"
  if (error instanceof MoveSession.ApplyChangesError)
    return "Таны өөрчлөлтийг очих хавтаст хэрэгжүүлж чадсангүй. Файлууд одоо байгаа өөрчлөлттэй зөрчилдөж болзошгүй."
  return error.message
}
