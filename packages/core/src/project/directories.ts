export * as ProjectDirectories from "./directories"

import { and, asc, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/node"
import { AbsolutePath, optional } from "../schema"
import { ProjectSchema } from "./schema"
import { ProjectDirectoryTable } from "./sql"
import { ProjectHistory } from "./history"
import { EventV2 } from "../event"

export interface Directory {
  readonly directory: AbsolutePath
  readonly strategy?: string
}

export const CreateInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
  strategy: Schema.optional(Schema.String),
  behavior: Schema.Literals(["ignore", "replace"]).pipe(Schema.optional),
})
export type CreateInput = typeof CreateInput.Type

export const RemoveInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
})
export type RemoveInput = typeof RemoveInput.Type

export const ListInput = Schema.Struct({
  projectID: ProjectSchema.ID,
}).annotate({ identifier: "Project.DirectoriesInput" })
export type ListInput = typeof ListInput.Type

export const ListOutput = Schema.Array(
  Schema.Struct({
    directory: AbsolutePath,
    strategy: optional(Schema.String),
  }),
).annotate({ identifier: "Project.Directories" })
export type ListOutput = typeof ListOutput.Type

export interface Interface {
  readonly list: (projectID: ProjectSchema.ID) => Effect.Effect<ReadonlyArray<Directory>>
  readonly get: (input: {
    projectID: ProjectSchema.ID
    directory: AbsolutePath
  }) => Effect.Effect<Directory | undefined>
  readonly contains: (input: { projectID: ProjectSchema.ID; directory: AbsolutePath }) => Effect.Effect<boolean>
  readonly create: (input: CreateInput) => Effect.Effect<boolean>
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean>
  readonly batch: (input: {
    projectID: ProjectSchema.ID
    operations: readonly ProjectHistory.DirectoryOperation[]
  }) => Effect.Effect<boolean[]>
}

export class Service extends Context.Service<Service, Interface>()("@mongolgpt/ProjectDirectories") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const history = yield* ProjectHistory.Service
    const events = yield* EventV2.Service

    const batch = Effect.fn("ProjectDirectories.batch")(function* (input: {
      projectID: ProjectSchema.ID
      operations: readonly ProjectHistory.DirectoryOperation[]
    }) {
      return yield* history.directories(input.projectID, input.operations).pipe(Effect.orDie)
    })

    const create = Effect.fn("ProjectDirectories.create")(function* (input: CreateInput) {
      const results = yield* batch({
        projectID: input.projectID,
        operations: [
          { type: "create", directory: input.directory, strategy: input.strategy, behavior: input.behavior },
        ],
      })
      return results[0]!
    })

    const remove = Effect.fn("ProjectDirectories.remove")(function* (input: RemoveInput) {
      const results = yield* batch({
        projectID: input.projectID,
        operations: [{ type: "remove", directory: input.directory }],
      })
      return results[0]!
    })

    const list = Effect.fn("ProjectDirectories.list")(function* (projectID: ProjectSchema.ID) {
      yield* events.check
      const rows = yield* db
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, projectID))
        .orderBy(desc(ProjectDirectoryTable.time_created), asc(ProjectDirectoryTable.directory))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ directory: row.directory, strategy: row.strategy ?? undefined }))
    })

    const contains = Effect.fn("ProjectDirectories.contains")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      yield* events.check
      return (
        (yield* db
          .select({ directory: ProjectDirectoryTable.directory })
          .from(ProjectDirectoryTable)
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, input.directory),
            ),
          )
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const get = Effect.fn("ProjectDirectories.get")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      yield* events.check
      const row = yield* db
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(
          and(
            eq(ProjectDirectoryTable.project_id, input.projectID),
            eq(ProjectDirectoryTable.directory, input.directory),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? { directory: row.directory, strategy: row.strategy ?? undefined } : undefined
    })

    return Service.of({
      list,
      get,
      contains,
      create,
      remove,
      batch,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(ProjectHistory.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, ProjectHistory.node, EventV2.node],
})
