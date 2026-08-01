import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { TodoWriteTool } from "../../src/tool/todo"
import { Todo } from "../../src/session/todo"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

const updated: Todo.Info[][] = []
const todoLayer = Layer.succeed(Todo.Service, {
  update: (input) => Effect.sync(() => void updated.push([...input.todos])),
  get: () => Effect.succeed([]),
})

const toolLayer = Layer.mergeAll(
  todoLayer,
  Agent.defaultLayer,
  Truncate.defaultLayer,
)

const it = testEffect(toolLayer)

describe("tool.todo", () => {
  it.instance("uses a Mongolian title and updates the todo service", () =>
    Effect.gen(function* () {
      updated.length = 0
      const toolInfo = yield* TodoWriteTool
      const tool = yield* toolInfo.init()
      const todos = [
        { content: "Finish localization", status: "pending", priority: "high" },
        { content: "Review patch", status: "completed", priority: "medium" },
      ] as const
      const result = yield* tool.execute(
        { todos: [...todos] },
        {
          sessionID: SessionID.make("ses_test-session"),
          messageID: MessageID.make("msg_test-message"),
          callID: "test-call",
          agent: "test-agent",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.title).toBe("1 хийх ажил")
      expect(updated).toEqual([todos])
    }),
  )
})
