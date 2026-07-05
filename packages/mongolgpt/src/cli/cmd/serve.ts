import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@mongolgpt/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "headless MongolGPT сервер эхлүүлэх",
  // Server loads instances per-request via x-mongolgpt-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.MONGOLGPT_SERVER_PASSWORD) {
      console.log("Анхааруулга: MONGOLGPT_SERVER_PASSWORD тохируулаагүй байна; сервер хамгаалалтгүй.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`mongolgpt server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
