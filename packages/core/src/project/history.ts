export * as ProjectHistory from "./history"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Semaphore, Types } from "effect"
import { Project } from "@mongolgpt/schema/project"
import { Changed } from "@mongolgpt/schema/project-history"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/node"
import { AbsolutePath } from "../schema"
import { ProjectDirectoryTable, ProjectTable } from "./sql"
import { SessionTable } from "../session/sql"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import type { Location } from "../location"

export { Changed }
type Change = EventV2.Data<typeof Changed>["change"]

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Project.NotFoundError", {
  projectID: Project.ID,
}) {}

export function fromRow(row: typeof ProjectTable.$inferSelect): Types.DeepMutable<Project.Info> {
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ? Schema.decodeUnknownSync(Project.Vcs)(row.vcs) : undefined,
    name: row.name ?? undefined,
    icon:
      row.icon_url || row.icon_url_override || row.icon_color
        ? {
            url: row.icon_url ?? undefined,
            override: row.icon_url_override ?? undefined,
            color: row.icon_color ?? undefined,
          }
        : undefined,
    commands: row.commands ?? undefined,
    time: { created: row.time_created, updated: row.time_updated, initialized: row.time_initialized ?? undefined },
    sandboxes: row.sandboxes,
  }
}

export interface Interface {
  readonly ensure: (input: EnsureInput) => Effect.Effect<void>
  readonly change: (projectID: Project.ID, change: Change) => Effect.Effect<void, NotFoundError>
  readonly directories: (
    projectID: Project.ID,
    operations: readonly DirectoryOperation[],
  ) => Effect.Effect<boolean[], NotFoundError>
}

export type EnsureInput = {
  readonly id: Project.ID
  readonly previous?: Project.ID
  readonly worktree: AbsolutePath
  readonly vcs?: NonNullable<Project.Info["vcs"]>
  readonly openedDirectory?: AbsolutePath
  readonly location?: Location.Ref
}

export type DirectoryOperation =
  | { readonly type: "remove"; readonly directory: AbsolutePath }
  | {
      readonly type: "create"
      readonly directory: AbsolutePath
      readonly strategy?: string
      readonly behavior?: "ignore" | "replace"
    }

export class Service extends Context.Service<Service, Interface>()("@mongolgpt/ProjectHistory") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const lock = yield* Semaphore.make(1)

    yield* events.project(Changed, ({ data }) =>
      Effect.gen(function* () {
        const id = data.projectID
        const change = data.change
        if (change.type === "saved") {
          if (change.info.id !== id) return yield* Effect.die("Төслийн хадгалалтын таних дугаар зөрсөн байна")
          const info = change.info
          const current = change.discovered
            ? yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get()
            : undefined
          const worktree = current && id !== Project.ID.global ? current.worktree : AbsolutePath.make(info.worktree)
          const sandboxes = current
            ? current.sandboxes.filter((directory) => !change.missingSandboxes?.includes(directory))
            : info.sandboxes.map((value) => AbsolutePath.make(value))
          const opened = change.openedDirectory && AbsolutePath.make(change.openedDirectory.directory)
          if (current && id !== Project.ID.global && opened && opened !== worktree && !sandboxes.includes(opened))
            sandboxes.push(opened)
          const row = {
            id,
            worktree,
            vcs: info.vcs ?? null,
            name: current ? current.name : (info.name ?? null),
            icon_url: current ? current.icon_url : (info.icon?.url ?? null),
            icon_url_override: current ? current.icon_url_override : (info.icon?.override ?? null),
            icon_color: current ? current.icon_color : (info.icon?.color ?? null),
            commands: current ? current.commands : info.commands ? { ...info.commands } : null,
            time_created: current?.time_created ?? info.time.created,
            time_updated: current ? Math.max(current.time_updated, info.time.updated) : info.time.updated,
            time_initialized: current ? current.time_initialized : (info.time.initialized ?? null),
            sandboxes,
          }
          yield* db.insert(ProjectTable).values(row).onConflictDoUpdate({ target: ProjectTable.id, set: row }).run()
          if (change.directories) {
            yield* db.delete(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, id)).run()
            for (const directory of change.directories) {
              yield* db
                .insert(ProjectDirectoryTable)
                .values({
                  project_id: id,
                  directory: AbsolutePath.make(directory.directory),
                  type: directory.type ?? null,
                  strategy: directory.strategy ?? null,
                  time_created: directory.time,
                })
                .run()
            }
          }
          if (change.openedDirectory && id !== Project.ID.global) {
            yield* db
              .insert(ProjectDirectoryTable)
              .values({
                project_id: id,
                directory: AbsolutePath.make(change.openedDirectory.directory),
                type: change.openedDirectory.type ?? null,
                strategy: change.openedDirectory.strategy ?? null,
                time_created: change.openedDirectory.time,
              })
              .onConflictDoNothing()
              .run()
          }
          if (id !== Project.ID.global && change.adoptDirectory) {
            yield* db
              .update(SessionTable)
              .set({ project_id: id, time_updated: sql`${SessionTable.time_updated}` })
              .where(
                and(
                  eq(SessionTable.project_id, Project.ID.global),
                  eq(SessionTable.directory, AbsolutePath.make(change.adoptDirectory)),
                ),
              )
              .run()
          }
          return
        }

        if (change.type === "migrated") {
          if (change.previousID === Project.ID.global || change.previousID === id) return
          const old = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, change.previousID)).get()
          const current = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get()
          if (old && !current)
            yield* db
              .insert(ProjectTable)
              .values({ ...old, id, time_updated: change.time })
              .run()
          yield* db.delete(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, change.previousID)).run()
          yield* db
            .update(SessionTable)
            .set({ project_id: id, time_updated: sql`${SessionTable.time_updated}` })
            .where(eq(SessionTable.project_id, change.previousID))
            .run()
          yield* db
            .update(WorkspaceTable)
            .set({ project_id: id })
            .where(eq(WorkspaceTable.project_id, change.previousID))
            .run()
          if (old) yield* db.delete(ProjectTable).where(eq(ProjectTable.id, change.previousID)).run()
          return
        }

        const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get()
        if (!row) return yield* Effect.die(new NotFoundError({ projectID: id }))
        if (change.type === "directories") {
          for (const operation of change.operations) {
            if (operation.type === "remove") {
              yield* db
                .delete(ProjectDirectoryTable)
                .where(
                  and(
                    eq(ProjectDirectoryTable.project_id, id),
                    eq(ProjectDirectoryTable.directory, AbsolutePath.make(operation.directory)),
                  ),
                )
                .run()
              continue
            }
            const entry = operation.entry
            const directory = {
              project_id: id,
              directory: AbsolutePath.make(entry.directory),
              strategy: entry.strategy ?? null,
              type: entry.type ?? null,
              time_created: entry.time,
            }
            yield* db
              .insert(ProjectDirectoryTable)
              .values(directory)
              .onConflictDoUpdate({
                target: [ProjectDirectoryTable.project_id, ProjectDirectoryTable.directory],
                set: directory,
              })
              .run()
          }
          return
        }
        if (change.type === "updated") {
          yield* db
            .update(ProjectTable)
            .set({
              name: change.name,
              icon_url: change.icon?.url,
              icon_url_override: change.icon?.override,
              icon_color: change.icon?.color,
              commands: change.commands ? { ...change.commands } : undefined,
              time_updated: change.time,
            })
            .where(eq(ProjectTable.id, id))
            .run()
          return
        }
        if (change.type === "initialized") {
          yield* db
            .update(ProjectTable)
            .set({ time_initialized: change.time, time_updated: change.time })
            .where(eq(ProjectTable.id, id))
            .run()
          return
        }
        const directory = AbsolutePath.make(change.directory)
        const sandboxes =
          change.type === "sandbox-added"
            ? [...new Set([...row.sandboxes, directory])]
            : row.sandboxes.filter((value) => value !== directory)
        yield* db
          .update(ProjectTable)
          .set({ sandboxes, time_updated: change.time })
          .where(eq(ProjectTable.id, id))
          .run()
      }).pipe(Effect.orDie),
    )

    const baseline = Effect.fn("ProjectHistory.baseline")(function* (projectID: Project.ID) {
      if ((yield* EventV2.latestSequence(db, projectID)) >= 0) return
      const snapshot = yield* db
        .transaction(() =>
          Effect.gen(function* () {
            const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()
            if (!row) return
            const directories = yield* db
              .select()
              .from(ProjectDirectoryTable)
              .where(eq(ProjectDirectoryTable.project_id, projectID))
              .all()
            return {
              info: fromRow(row),
              directories: directories.map((item) => ({
                directory: item.directory,
                type: item.type ?? undefined,
                strategy: item.strategy ?? undefined,
                time: item.time_created,
              })),
            }
          }),
        )
        .pipe(Effect.orDie)
      if (snapshot) yield* events.publish(Changed, { projectID, change: { type: "saved", ...snapshot } })
    })

    const ensure = Effect.fn("ProjectHistory.ensure")(function* (input: EnsureInput) {
      yield* events.check
      const latest = yield* EventV2.latestSequence(db, input.id)
      const row = yield* db
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (row) {
        if (latest >= 0) return
        // Existing rows carry user/projector metadata; baseline them instead of overwriting with resolver defaults.
        yield* baseline(input.id)
        return
      }
      if (latest < 0 && input.previous && input.previous !== Project.ID.global && input.previous !== input.id) {
        const previous = yield* db
          .select({ id: ProjectTable.id })
          .from(ProjectTable)
          .where(eq(ProjectTable.id, input.previous))
          .get()
          .pipe(Effect.orDie)
        if (previous) {
          yield* change(input.id, { type: "migrated", previousID: input.previous, time: Date.now() }).pipe(Effect.orDie)
          return
        }
      }
      const now = Date.now()
      yield* events.publish(
        Changed,
        {
          projectID: input.id,
          change: {
            type: "saved",
            info: {
              id: input.id,
              worktree: input.worktree,
              vcs: input.vcs,
              time: { created: now, updated: now },
              sandboxes: [],
            },
            discovered: true,
            openedDirectory: input.openedDirectory ? { directory: input.openedDirectory, time: now } : undefined,
          },
        },
        { location: input.location },
      )
    })

    const change = Effect.fn("ProjectHistory.change")(function* (projectID: Project.ID, change: Change) {
      yield* events.check
      // A legacy row must have an authoritative baseline before its first delta or migration.
      yield* baseline(projectID)
      if (change.type === "migrated") yield* baseline(change.previousID)
      if (change.type !== "saved" && change.type !== "migrated") {
        const row = yield* db
          .select({ id: ProjectTable.id })
          .from(ProjectTable)
          .where(eq(ProjectTable.id, projectID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ projectID })
      }
      yield* events.publish(Changed, { projectID, change })
    })

    const directories = Effect.fn("ProjectHistory.directories")(function* (
      projectID: Project.ID,
      operations: readonly DirectoryOperation[],
    ) {
      yield* events.check
      if (operations.length === 0) return []
      const rows = yield* db
        .select()
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, projectID))
        .all()
        .pipe(Effect.orDie)
      const entries = new Map(rows.map((row) => [row.directory, row]))
      const changes: Extract<Change, { type: "directories" }>["operations"][number][] = []
      const results = operations.map((operation) => {
        const directory = operation.directory
        const current = entries.get(directory)
        if (operation.type === "remove") {
          if (!entries.delete(directory)) return false
          changes.push({ type: "remove", directory })
          return true
        }
        if (current && (operation.behavior !== "replace" || current.strategy === (operation.strategy ?? null)))
          return false
        const entry = {
          project_id: projectID,
          directory,
          type: current?.type ?? null,
          strategy: operation.strategy ?? null,
          time_created: current?.time_created ?? Date.now(),
        }
        entries.set(directory, entry)
        changes.push({
          type: "upsert",
          entry: {
            directory,
            type: entry.type ?? undefined,
            strategy: entry.strategy ?? undefined,
            time: entry.time_created,
          },
        })
        return true
      })
      if (changes.length) yield* change(projectID, { type: "directories", operations: changes })
      return results
    })
    return Service.of({
      ensure: (input) => lock.withPermit(ensure(input)),
      change: (projectID, input) => lock.withPermit(change(projectID, input)),
      directories: (projectID, operations) => lock.withPermit(directories(projectID, operations)),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
