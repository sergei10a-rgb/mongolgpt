export * as ProjectHistory from "./project-history"

import { Schema } from "effect"
import { Event } from "./event"
import { Project } from "./project"
import { NonNegativeInt, optional } from "./schema"

export const Directory = Schema.Struct({
  directory: Schema.String,
  type: optional(Schema.Literals(["main", "root", "git_worktree"])),
  strategy: optional(Schema.String),
  time: NonNegativeInt,
})
export interface Directory extends Schema.Schema.Type<typeof Directory> {}

// Storage-only events. The existing project.updated UI contract stays unchanged.
const Changed = Event.define({
  type: "project.history.changed",
  durable: { aggregate: "projectID", version: 1 },
  schema: {
    projectID: Project.ID,
    change: Schema.Union([
      Schema.Struct({
        type: Schema.Literal("saved"),
        info: Project.Info,
        discovered: optional(Schema.Boolean),
        missingSandboxes: optional(Schema.Array(Schema.String)),
        directories: optional(Schema.Array(Directory)),
        openedDirectory: optional(Directory),
        adoptDirectory: optional(Schema.String),
      }),
      Schema.Struct({
        type: Schema.Literal("directories"),
        operations: Schema.Array(
          Schema.Union([
            Schema.Struct({ type: Schema.Literal("upsert"), entry: Directory }),
            Schema.Struct({ type: Schema.Literal("remove"), directory: Schema.String }),
          ]),
        ),
      }),
      Schema.Struct({
        type: Schema.Literal("updated"),
        name: optional(Schema.String),
        icon: optional(Project.Icon),
        commands: optional(Project.Commands),
        time: NonNegativeInt,
      }),
      Schema.Struct({ type: Schema.Literal("initialized"), time: NonNegativeInt }),
      Schema.Struct({
        type: Schema.Literals(["sandbox-added", "sandbox-removed"]),
        directory: Schema.String,
        time: NonNegativeInt,
      }),
      Schema.Struct({
        type: Schema.Literal("migrated"),
        previousID: Project.ID,
        time: NonNegativeInt,
      }),
    ]),
  },
})

export const Definitions = Event.inventory(Changed)
export { Changed }
