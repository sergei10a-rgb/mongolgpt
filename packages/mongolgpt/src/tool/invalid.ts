import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Ашиглахгүй",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Буруу tool",
        output: `Tool-д өгсөн аргументууд буруу байна: ${params.error}`,
        metadata: {},
      }),
  }),
)
