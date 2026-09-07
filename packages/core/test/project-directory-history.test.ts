import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { ProjectHistory } from "@mongolgpt/core/project/history"
import { ProjectDirectories } from "@mongolgpt/core/project/directories"
import { ProjectDirectoryTable, ProjectTable } from "@mongolgpt/core/project/sql"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { Project } from "@mongolgpt/schema/project"
import { Location } from "@mongolgpt/core/location"
import { Service } from "@mongolgpt/core/location-context"

const projectID = Project.ID.make("directory-history")
const root = AbsolutePath.make("/workspace/root")
const old = AbsolutePath.make("/workspace/old")
const next = AbsolutePath.make("/workspace/next")

const layer = (append: (event: EventV2.SerializedEvent) => Effect.Effect<void>) =>
  ProjectDirectories.layer.pipe(
    Layer.provideMerge(ProjectHistory.layer),
    Layer.provideMerge(EventV2.layerWith({ journal: { append } })),
    Layer.provideMerge(Database.layerFromPath(":memory:")),
  )

const seed = Effect.gen(function* () {
  const history = yield* ProjectHistory.Service
  yield* history.change(projectID, {
    type: "saved",
    info: { id: projectID, worktree: root, name: "Retained", sandboxes: [], time: { created: 1, updated: 2 } },
    directories: [
      { directory: root, type: "main", strategy: "original", time: 5 },
      { directory: old, type: "git_worktree", strategy: "git_worktree", time: 6 },
    ],
  })
})

const snapshot = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    projects: yield* db.select().from(ProjectTable).all(),
    directories: yield* db.select().from(ProjectDirectoryTable).orderBy(ProjectDirectoryTable.directory).all(),
  }
})

describe("Native directory history", () => {
  test("keeps the public and storage location service identity canonical", () => {
    expect(Location.Service).toBe(Service)
  })

  test("journals one ordered batch, preserves metadata and no-op results, and restores it exactly", async () => {
    const wire: EventV2.SerializedEvent[] = []
    const expected = await Effect.gen(function* () {
      const directories = yield* ProjectDirectories.Service
      yield* seed
      expect(
        yield* directories.batch({
          projectID,
          operations: [
            { type: "create", directory: root, strategy: "ignored" },
            { type: "create", directory: root, strategy: "replacement", behavior: "replace" },
            { type: "create", directory: next, strategy: "git_worktree" },
            { type: "create", directory: next, strategy: "git_worktree", behavior: "replace" },
            { type: "remove", directory: old },
            { type: "remove", directory: old },
          ],
        }),
      ).toEqual([false, true, true, false, true, false])
      expect(wire).toHaveLength(2)
      expect(wire[1]?.data.change).toMatchObject({
        type: "directories",
        operations: [{ type: "upsert" }, { type: "upsert" }, { type: "remove" }],
      })
      expect(yield* directories.create({ projectID, directory: next, strategy: "ignored" })).toBe(false)
      expect(yield* directories.remove({ projectID, directory: old })).toBe(false)
      expect(yield* directories.batch({ projectID, operations: [] })).toEqual([])
      expect(wire).toHaveLength(2)
      const result = yield* snapshot
      expect(result.directories.find((row) => row.directory === root)).toMatchObject({
        type: "main",
        strategy: "replacement",
        time_created: 5,
      })
      expect(result.projects[0]).toMatchObject({ name: "Retained", time_created: 1, time_updated: 2 })
      return result
    }).pipe(
      Effect.provide(
        layer((event) =>
          Effect.sync(() => {
            wire.push(event)
          }),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    )
    await Effect.gen(function* () {
      const events = yield* EventV2.Service
      for (const event of wire) yield* events.replay(event)
      for (const event of wire) yield* events.replay(event)
      expect(yield* snapshot).toEqual(expected)
    }).pipe(Effect.provide(layer(() => Effect.die("replay must not append"))), Effect.scoped, Effect.runPromise)
  })

  test("does not acknowledge partial refresh and fences directory reads after a lost receipt", async () => {
    const wire: EventV2.SerializedEvent[] = []
    await Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const receipt = yield* Deferred.make<void>()
      const acknowledged = yield* Deferred.make<void>()
      yield* Effect.gen(function* () {
        const directories = yield* ProjectDirectories.Service
        const events = yield* EventV2.Service
        yield* seed
        const before = yield* snapshot
        const observed: string[] = []
        yield* events.listen((event) =>
          Effect.sync(() => {
            observed.push(event.type)
          }),
        )
        const fiber = yield* directories
          .batch({
            projectID,
            operations: [
              { type: "remove", directory: old },
              { type: "create", directory: next, strategy: "git_worktree" },
            ],
          })
          .pipe(
            Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
            Effect.exit,
            Effect.forkScoped,
          )
        yield* Deferred.await(entered)
        expect(yield* Deferred.isDone(acknowledged)).toBe(false)
        expect(observed).toEqual([])
        yield* Deferred.succeed(receipt, undefined)
        expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true)
        expect(yield* snapshot).toEqual(before)
        expect(observed).toEqual([])
        expect(yield* Deferred.isDone(acknowledged)).toBe(false)
        const reads: Effect.Effect<unknown>[] = [
          directories.list(projectID),
          directories.get({ projectID, directory: root }),
          directories.contains({ projectID, directory: root }),
        ]
        for (const read of reads) expect(Exit.isFailure(yield* read.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* directories.remove({ projectID, directory: old }).pipe(Effect.exit))).toBe(true)
        expect(wire).toHaveLength(2)
      }).pipe(
        Effect.provide(
          layer((event) =>
            Effect.gen(function* () {
              wire.push(event)
              if (wire.length === 1) return
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(receipt)
              return yield* Effect.die("lost directory receipt")
            }),
          ),
        ),
      )
    }).pipe(Effect.scoped, Effect.runPromise)
    await Effect.gen(function* () {
      const events = yield* EventV2.Service
      const directories = yield* ProjectDirectories.Service
      for (const event of wire) yield* events.replay(event)
      expect(yield* directories.contains({ projectID, directory: old })).toBe(false)
      expect(yield* directories.get({ projectID, directory: next })).toEqual({
        directory: next,
        strategy: "git_worktree",
      })
    }).pipe(Effect.provide(layer(() => Effect.die("replay must not append"))), Effect.scoped, Effect.runPromise)
  })

  test("serializes competing creates after one legacy baseline", async () => {
    const wire: EventV2.SerializedEvent[] = []
    await Effect.gen(function* () {
      const { db } = yield* Database.Service
      const directories = yield* ProjectDirectories.Service
      // A real legacy project exists before durable directory commands are enabled.
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: root, sandboxes: [], time_created: 1, time_updated: 2 })
        .run()
      const result = yield* Effect.all(
        [
          directories.create({ projectID, directory: next, strategy: "first" }),
          directories.create({ projectID, directory: next, strategy: "second" }),
        ],
        { concurrency: 2 },
      )
      expect(result.filter(Boolean)).toHaveLength(1)
      expect(wire).toHaveLength(2)
      expect(wire[0]?.data.change).toMatchObject({ type: "saved", info: { id: projectID } })
      expect(wire[1]?.data.change).toMatchObject({ type: "directories" })
      expect(yield* directories.list(projectID)).toHaveLength(1)
    }).pipe(
      Effect.provide(
        layer((event) =>
          Effect.sync(() => {
            wire.push(event)
          }),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    )
  })
})
