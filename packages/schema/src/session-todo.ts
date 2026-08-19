export * as SessionTodo from "./session-todo"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Даалгаврын товч тайлбар" }),
  status: Schema.String.annotate({
    description: "Даалгаврын одоогийн төлөв: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({
    description: "Даалгаврын ач холбогдол: high, medium, low",
  }),
}).annotate({ identifier: "Todo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "todo.updated",
  schema: {
    sessionID: SessionID,
    todos: Schema.Array(Info),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
