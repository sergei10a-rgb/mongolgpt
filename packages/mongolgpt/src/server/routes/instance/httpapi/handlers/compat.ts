import { applyCompatImport, planCompatImport } from "@/compat"
import { InstanceRef } from "@/effect/instance-ref"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { CompatImportError, CompatImportPayload } from "../groups/compat"

export const compatHandlers = HttpApiBuilder.group(InstanceHttpApi, "compat", (handlers) =>
  Effect.gen(function* () {
    const plan = Effect.fn("CompatHttpApi.plan")(function* (ctx: { payload: typeof CompatImportPayload.Type }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new CompatImportError({ message: "Instance context олдсонгүй" })
      return yield* compat(() => planCompatImport(ctx.payload, instance, { writeAdapters: false }))
    })

    const apply = Effect.fn("CompatHttpApi.apply")(function* (ctx: { payload: typeof CompatImportPayload.Type }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new CompatImportError({ message: "Instance context олдсонгүй" })
      return yield* compat(() => applyCompatImport(ctx.payload, instance))
    })

    return handlers.handle("plan", plan).handle("apply", apply)
  }),
)

function compat<T>(fn: () => Promise<T>) {
  return Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new CompatImportError({
        message: error instanceof Error ? error.message : String(error),
      }),
  })
}
