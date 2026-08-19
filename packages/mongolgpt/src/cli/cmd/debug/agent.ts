import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"

export const AgentCommand = effectCmd({
  command: "agent <name>",
  describe: "агентийн тохиргооны дэлгэрэнгүйг харуулах",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        demandOption: true,
        description: "Agent-ийн нэр",
      })
      .option("tool", {
        type: "string",
        description: "ажиллуулах хэрэгслийн ID",
      })
      .option("params", {
        type: "string",
        description: "хэрэгслийн параметрүүдийг JSON эсвэл JS объектын бичвэрээр өгөх",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const { debugAgent } = yield* Effect.promise(() => import("./agent.handler"))
      return yield* debugAgent(args)
    }),
})
