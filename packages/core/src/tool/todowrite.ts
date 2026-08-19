export * as TodoWriteTool from "./todowrite"

import { ToolFailure } from "@mongolgpt/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { SessionTodo } from "../session/todo"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "todowrite"

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "Шинэчилсэн хийх ажлын жагсаалт" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output.todos, null, 2)

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const todos = yield* SessionTodo.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Одоогийн код бичих сессийн бүтэцтэй хийх ажлын жагсаалтыг үүсгэж, хөтөлнө. Олон алхамтай ажлын явцыг хянаж, todo төлөвүүдийг шинэчилж байлгана.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              yield* todos.update({ sessionID: context.sessionID, todos: input.todos })
              return { todos: input.todos }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Хийх ажлын жагсаалтыг шинэчилж чадсангүй" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
