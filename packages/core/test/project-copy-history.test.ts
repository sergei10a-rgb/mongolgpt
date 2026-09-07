import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { FSUtil } from "@mongolgpt/core/fs-util"
import { Git } from "@mongolgpt/core/git"
import { Project } from "@mongolgpt/core/project"
import { ProjectCopy } from "@mongolgpt/core/project/copy"
import { ProjectDirectories } from "@mongolgpt/core/project/directories"
import { ProjectHistory } from "@mongolgpt/core/project/history"
import { ProjectDirectoryTable } from "@mongolgpt/core/project/sql"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const projectID = Project.ID.make("copy-history-project")
const gitWorktree = ProjectCopy.StrategyID.make("git_worktree")

type DirectoryRow = {
  readonly directory: AbsolutePath
  readonly type: "main" | "root" | "git_worktree" | null
  readonly strategy: string | null
  readonly time_created: number
}

const layer = (append: (event: EventV2.SerializedEvent) => Effect.Effect<void>) =>
  ProjectCopy.layer.pipe(
    Layer.provideMerge(
      ProjectDirectories.layer.pipe(
        Layer.provideMerge(ProjectHistory.layer),
        Layer.provideMerge(EventV2.layerWith({ journal: { append } })),
        Layer.provideMerge(Database.layerFromPath(":memory:")),
      ),
    ),
    Layer.provideMerge(FSUtil.defaultLayer),
    Layer.provideMerge(Git.defaultLayer),
  )

const it = testEffect(Layer.empty)

function abs(input: string) {
  return AbsolutePath.make(input)
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@mongolgpt.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

function setup() {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const copiesRoot = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => initRepo(root.path))
    const sourceDirectory = abs(yield* Effect.promise(() => fs.realpath(root.path)))
    const external = abs(path.join(copiesRoot.path, "external-worktree"))
    const stale = abs(path.join(copiesRoot.path, "stale-worktree"))
    yield* Effect.promise(() => $`git worktree add --detach ${external} HEAD`.cwd(root.path).quiet())
    const discovered = abs(yield* Effect.promise(() => fs.realpath(external)))
    const history = yield* ProjectHistory.Service
    yield* history.change(projectID, {
      type: "saved",
      info: {
        id: projectID,
        worktree: sourceDirectory,
        name: "Copy history",
        sandboxes: [],
        time: { created: 1, updated: 2 },
      },
      directories: [
        { directory: sourceDirectory, type: "main", time: 1 },
        { directory: stale, type: "git_worktree", strategy: "git_worktree", time: 2 },
      ],
    })
    return { root, sourceDirectory, discovered, stale }
  })
}

const rows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select({
      directory: ProjectDirectoryTable.directory,
      type: ProjectDirectoryTable.type,
      strategy: ProjectDirectoryTable.strategy,
      time_created: ProjectDirectoryTable.time_created,
    })
    .from(ProjectDirectoryTable)
    .where(eq(ProjectDirectoryTable.project_id, projectID))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((items) => items.toSorted((a, b) => a.directory.localeCompare(b.directory)) as DirectoryRow[]),
    )
})

function expectProjection(actual: readonly DirectoryRow[], sourceDirectory: AbsolutePath, discovered: AbsolutePath) {
  expect(actual).toHaveLength(2)
  expect(actual[0]!.directory.localeCompare(actual[1]!.directory)).toBeLessThan(0)
  expect(actual).toContainEqual({ directory: sourceDirectory, type: "main", strategy: null, time_created: 1 })
  const discoveredRow = actual.find((row) => row.directory === discovered)
  expect(discoveredRow).toMatchObject({ directory: discovered, type: null, strategy: "git_worktree" })
  expect(typeof discoveredRow?.time_created).toBe("number")
}

describe("ProjectCopy refresh history", () => {
  it.live("journals one ordered private refresh batch and publishes only after ACK", () =>
    Effect.gen(function* () {
      const wire: EventV2.SerializedEvent[] = []
      const entered = yield* Deferred.make<void>()
      const receipt = yield* Deferred.make<void>()
      let blockRefresh = false

      yield* Effect.gen(function* () {
        const input = yield* setup()
        expect(wire).toHaveLength(1)
        const seed = wire[0]!
        wire.length = 0

        const events = yield* EventV2.Service
        const copies = yield* ProjectCopy.Service
        const publicEvents: EventV2.Payload[] = []
        const allEvents: EventV2.Payload[] = []
        yield* events.listen((event) =>
          Effect.sync(() => {
            allEvents.push(event)
            if (event.type === ProjectCopy.Event.Updated.type) publicEvents.push(event)
          }),
        )

        blockRefresh = true
        const refreshed = yield* copies.refresh({ projectID }).pipe(
          Effect.tap(() => Effect.sync(() => expect(publicEvents).toHaveLength(1))),
          Effect.forkScoped,
        )
        yield* Deferred.await(entered)
        expect(publicEvents).toEqual([])
        expect(allEvents).toEqual([])
        expect(wire).toHaveLength(1)
        const refreshEvent = wire[0]!
        expect(refreshEvent.aggregateID).toBe(projectID)
        expect(refreshEvent.seq).toBe(1)
        expect(refreshEvent.type).toBe(EventV2.versionedType(ProjectHistory.Changed.type, 1))
        const refreshData = refreshEvent.data as EventV2.Data<typeof ProjectHistory.Changed>
        expect(refreshData.projectID).toBe(projectID)
        expect(refreshData.change.type).toBe("directories")
        if (refreshData.change.type !== "directories") return yield* Effect.die("expected directories change")
        expect(refreshData.change.operations).toHaveLength(2)
        expect(refreshData.change.operations[0]).toMatchObject({
          type: "upsert",
          entry: { directory: input.discovered, strategy: "git_worktree" },
        })
        const first = refreshData.change.operations[0]
        if (first.type !== "upsert") return yield* Effect.die("expected upsert operation")
        expect(typeof first.entry.time).toBe("number")
        expect(refreshData.change.operations[1]).toEqual({ type: "remove", directory: input.stale })

        yield* Deferred.succeed(receipt, undefined)
        expect(yield* Fiber.join(refreshed)).toEqual({ updated: [input.discovered], removed: [input.stale] })
        expect(publicEvents.map((event) => event.data)).toEqual([{ projectID }])
        expect(publicEvents).toHaveLength(1)
        const after = yield* rows
        expectProjection(after, input.sourceDirectory, input.discovered)

        const replay = [seed, ...wire]
        yield* Effect.promise(() =>
          Effect.gen(function* () {
            const replayEvents = yield* EventV2.Service
            expect(yield* rows).toEqual([])
            for (const event of replay) yield* replayEvents.replay(event)
            expect(yield* rows).toEqual(after)
          }).pipe(Effect.provide(layer(() => Effect.die("replay must not append"))), Effect.scoped, Effect.runPromise),
        )
      }).pipe(
        Effect.provide(
          layer((event) =>
            Effect.gen(function* () {
              wire.push(event)
              if (!blockRefresh) return
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(receipt)
            }),
          ),
        ),
      )
    }),
  )

  it.live("rolls back, stays quiet, fences EventV2, and can replay a lost refresh receipt", () =>
    Effect.gen(function* () {
      const wire: EventV2.SerializedEvent[] = []
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let blockRefresh = false

      yield* Effect.gen(function* () {
        const input = yield* setup()
        const seed = wire[0]!
        wire.length = 0
        const before = yield* rows

        const events = yield* EventV2.Service
        const copies = yield* ProjectCopy.Service
        const publicEvents: EventV2.Payload[] = []
        yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === ProjectCopy.Event.Updated.type) publicEvents.push(event)
          }),
        )

        blockRefresh = true
        const refreshed = yield* copies.refresh({ projectID }).pipe(Effect.exit, Effect.forkScoped)
        yield* Deferred.await(entered)
        expect(publicEvents).toEqual([])
        expect(wire).toHaveLength(1)
        const refreshEvent = wire[0]!
        const refreshData = refreshEvent.data as EventV2.Data<typeof ProjectHistory.Changed>
        expect(refreshEvent.seq).toBe(1)
        expect(refreshData.change.type).toBe("directories")
        yield* Deferred.succeed(release, undefined)
        expect(Exit.isFailure(yield* Fiber.join(refreshed))).toBe(true)
        expect(yield* rows).toEqual(before)
        expect(publicEvents).toEqual([])
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(yield* ProjectDirectories.Service.use((svc) => svc.list(projectID)).pipe(Effect.exit)),
        ).toBe(true)

        const replay = [seed, ...wire]
        yield* Effect.promise(() =>
          Effect.gen(function* () {
            const replayEvents = yield* EventV2.Service
            expect(yield* rows).toEqual([])
            for (const event of replay) yield* replayEvents.replay(event)
            if (refreshData.change.type !== "directories") return yield* Effect.die("expected directories change")
            const first = refreshData.change.operations[0]
            if (first.type !== "upsert") return yield* Effect.die("expected upsert operation")
            const restored = yield* rows
            const restoredDiscovered = restored.find((row) => row.directory === input.discovered)
            expect(restoredDiscovered?.time_created).toBe(first.entry.time)
            expectProjection(restored, input.sourceDirectory, input.discovered)
          }).pipe(Effect.provide(layer(() => Effect.die("replay must not append"))), Effect.scoped, Effect.runPromise),
        )
      }).pipe(
        Effect.provide(
          layer((event) =>
            Effect.gen(function* () {
              wire.push(event)
              if (!blockRefresh) return
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return yield* Effect.die("lost remote receipt")
            }),
          ),
        ),
      )
    }),
  )
})
