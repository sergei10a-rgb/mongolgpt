import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Project } from "@mongolgpt/schema/project"
import { ProjectHistory } from "@mongolgpt/core/project/history"
import { EventV2 } from "@mongolgpt/core/event"
import { EventTable } from "@mongolgpt/core/event/sql"
import { Database } from "@mongolgpt/core/database/database"
import { ProjectDirectoryTable, ProjectTable } from "@mongolgpt/core/project/sql"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { Session } from "@mongolgpt/schema/session"
import { SessionTable } from "@mongolgpt/core/session/sql"
import { AbsolutePath } from "@mongolgpt/core/schema"

const projectID = Project.ID.make("project-history-test")
const info: Project.Info = {
  id: projectID,
  worktree: "/workspace/repo",
  name: "Project name",
  vcs: "git",
  commands: { start: "bun dev" },
  icon: { url: "data:image/png;base64,YQ==", override: "custom", color: "green" },
  time: { created: 10, updated: 20, initialized: 15 },
  sandboxes: ["/workspace/copy"],
}

const fresh = (append: (event: EventV2.SerializedEvent) => Effect.Effect<void>) =>
  Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
    Layer.provideMerge(EventV2.layerWith({ journal: { append } })),
    Layer.provideMerge(Database.layerFromPath(":memory:")),
  )

describe("Native project history", () => {
  test("discovery cannot overwrite newer acknowledged metadata or resurrect a removed sandbox", async () => {
    await Effect.gen(function* () {
      const history = yield* ProjectHistory.Service
      const { db } = yield* Database.Service
      yield* history.change(projectID, { type: "saved", info })
      yield* history.change(projectID, {
        type: "updated",
        name: "New name",
        icon: { color: "pink" },
        commands: { start: "new command" },
        time: 90,
      })
      yield* history.change(projectID, { type: "initialized", time: 100 })
      yield* history.change(projectID, { type: "sandbox-removed", directory: "/workspace/copy", time: 110 })
      yield* history.change(projectID, { type: "sandbox-added", directory: "/workspace/new", time: 120 })
      yield* history.change(projectID, {
        type: "saved",
        info: { ...info, name: undefined, icon: undefined, commands: undefined },
        discovered: true,
        missingSandboxes: [],
        openedDirectory: { directory: info.worktree, time: 20 },
      })
      const row = yield* db.select().from(ProjectTable).get()
      expect(row).toMatchObject({
        name: "New name",
        icon_color: "pink",
        commands: { start: "new command" },
        time_initialized: 100,
        time_updated: 120,
        sandboxes: [AbsolutePath.make("/workspace/new")],
      })
    }).pipe(Effect.provide(fresh(() => Effect.void)), Effect.scoped, Effect.runPromise)
  })

  test("serializes a complete legacy baseline before concurrent deltas and migration", async () => {
    const wire: EventV2.SerializedEvent[] = []
    const migratedID = Project.ID.make("legacy-migrated")
    const expected = await Effect.gen(function* () {
      const history = yield* ProjectHistory.Service
      const { db } = yield* Database.Service
      // Existing installation data intentionally predates the journal.
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: AbsolutePath.make(info.worktree),
          name: "Legacy",
          icon_color: "cyan",
          commands: { start: "legacy start" },
          time_created: 10,
          time_updated: 20,
          time_initialized: 15,
          sandboxes: [],
        })
        .run()
      yield* db
        .insert(ProjectDirectoryTable)
        .values({
          project_id: projectID,
          directory: AbsolutePath.make(info.worktree),
          type: "main",
          strategy: "legacy",
          time_created: 12,
        })
        .run()
      yield* Effect.all(
        [
          history.change(projectID, { type: "updated", name: "Renamed legacy", time: 30 }),
          history.change(projectID, { type: "sandbox-added", directory: "/workspace/next", time: 35 }),
        ],
        { concurrency: 2 },
      )
      expect(wire).toHaveLength(3)
      expect(wire[0]?.data.change).toMatchObject({
        type: "saved",
        info: { name: "Legacy", commands: { start: "legacy start" } },
        directories: [{ type: "main", strategy: "legacy", time: 12 }],
      })
      yield* history.change(migratedID, { type: "migrated", previousID: projectID, time: 40 })
      return yield* db.select().from(ProjectTable).get()
    }).pipe(
      Effect.provide(
        fresh((event) =>
          Effect.sync(() => {
            wire.push(event)
          }),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(wire).toHaveLength(4)
    await Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      for (const event of wire) yield* events.replay(event)
      expect(yield* db.select().from(ProjectTable).get()).toEqual(expected)
      expect(expected).toMatchObject({
        id: migratedID,
        name: "Renamed legacy",
        commands: { start: "legacy start" },
        icon_color: "cyan",
      })
    }).pipe(Effect.provide(fresh(() => Effect.die("replay must not upload"))), Effect.scoped, Effect.runPromise)
  })

  test("adopting a global session preserves its activity timestamp during replay", async () => {
    const wire: EventV2.SerializedEvent[] = []
    const sessionID = Session.ID.create()
    await Effect.gen(function* () {
      const history = yield* ProjectHistory.Service
      const events = yield* EventV2.Service
      yield* history.change(Project.ID.global, {
        type: "saved",
        info: { ...info, id: Project.ID.global, worktree: "/" },
      })
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: Schema.decodeUnknownSync(SessionV1.SessionInfo)({
          id: sessionID,
          projectID: "global",
          slug: "global-adoption",
          directory: info.worktree,
          title: "Adopted",
          version: "test",
          time: { created: 10, updated: 20 },
        }),
      })
      yield* history.change(projectID, { type: "saved", info, adoptDirectory: info.worktree })
    }).pipe(
      Effect.provide(
        fresh((event) =>
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
      const { db } = yield* Database.Service
      for (const event of wire) yield* events.replay(event)
      expect(yield* db.select().from(SessionTable).get()).toMatchObject({
        project_id: projectID,
        time_created: 10,
        time_updated: 20,
      })
    }).pipe(Effect.provide(fresh(() => Effect.die("replay must not upload"))), Effect.scoped, Effect.runPromise)
  })

  test("rebuilds complete project metadata, directories and dependent sessions without seeding projects", async () => {
    const wire: EventV2.SerializedEvent[] = []
    const append = (event: EventV2.SerializedEvent) =>
      Effect.sync(() => {
        wire.push(event)
      })
    const sessionID = Session.ID.create()
    const expected = await Effect.gen(function* () {
      const history = yield* ProjectHistory.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* history.change(projectID, {
        type: "saved",
        info,
        directories: [{ directory: "/workspace/copy", type: "git_worktree", strategy: "git-worktree", time: 5 }],
        openedDirectory: { directory: "/workspace/repo", time: 10 },
      })
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: Schema.decodeUnknownSync(SessionV1.SessionInfo)({
          id: sessionID,
          projectID,
          slug: "restore-project",
          directory: "/workspace/repo",
          title: "Restored project session",
          version: "test",
          time: { created: 30, updated: 30 },
        }),
      })
      yield* history.change(projectID, { type: "updated", name: "Renamed", icon: { color: "blue" }, time: 40 })
      yield* history.change(projectID, { type: "initialized", time: 45 })
      yield* history.change(projectID, { type: "sandbox-added", directory: "/workspace/next", time: 50 })
      yield* history.change(projectID, { type: "sandbox-removed", directory: "/workspace/copy", time: 55 })
      return {
        projects: yield* db.select().from(ProjectTable).all(),
        directories: yield* db.select().from(ProjectDirectoryTable).orderBy(ProjectDirectoryTable.directory).all(),
        sessions: yield* db.select().from(SessionTable).all(),
      }
    }).pipe(Effect.provide(fresh(append)), Effect.scoped, Effect.runPromise)

    expect(wire).toHaveLength(6)
    expect(expected.projects[0]).toMatchObject({
      name: "Renamed",
      time_initialized: 45,
      commands: { start: "bun dev" },
      icon_color: "blue",
      icon_url_override: "custom",
    })
    const restored = JSON.parse(JSON.stringify(wire)) as EventV2.SerializedEvent[]
    await Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      expect(yield* db.select().from(ProjectTable).all()).toEqual([])
      for (const event of restored) yield* events.replay(event)
      for (const event of restored) yield* events.replay(event)
      expect(yield* db.select().from(ProjectTable).all()).toEqual(expected.projects)
      expect(yield* db.select().from(ProjectDirectoryTable).orderBy(ProjectDirectoryTable.directory).all()).toEqual(
        expected.directories,
      )
      expect(yield* db.select().from(SessionTable).all()).toEqual(expected.sessions)
      expect(yield* db.select().from(EventTable).all()).toHaveLength(6)
    }).pipe(Effect.provide(fresh(append)), Effect.scoped, Effect.runPromise)
    expect(wire).toHaveLength(6)
  })

  test("does not acknowledge or notify metadata changes before the remote receipt", async () => {
    await Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const receipt = yield* Deferred.make<void>()
      const acknowledged = yield* Deferred.make<void>()
      const observed: string[] = []
      yield* Effect.gen(function* () {
        const history = yield* ProjectHistory.Service
        const events = yield* EventV2.Service
        yield* events.listen((event) =>
          Effect.sync(() => {
            observed.push(event.type)
          }),
        )
        const fiber = yield* history.change(projectID, { type: "saved", info }).pipe(
          Effect.tap(() => Deferred.succeed(acknowledged, undefined)),
          Effect.forkScoped,
        )
        yield* Deferred.await(entered)
        expect(observed).toEqual([])
        expect(yield* Deferred.isDone(acknowledged)).toBe(false)
        yield* Deferred.succeed(receipt, undefined)
        yield* Fiber.join(fiber)
        expect(observed).toEqual([ProjectHistory.Changed.type])
      }).pipe(
        Effect.provide(fresh(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(receipt))))),
      )
    }).pipe(Effect.scoped, Effect.runPromise)
  })

  test("rolls back unconfirmed metadata and blocks subsequent writes", async () => {
    const wire: EventV2.SerializedEvent[] = []
    await Effect.gen(function* () {
      const history = yield* ProjectHistory.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* history.change(projectID, { type: "saved", info })
      const before = yield* db.select().from(ProjectTable).get()
      const result = yield* history
        .change(projectID, { type: "updated", name: "Unconfirmed", time: 60 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* db.select().from(ProjectTable).get()).toEqual(before)
      expect(yield* db.select().from(EventTable).all()).toHaveLength(1)
      expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(yield* history.change(projectID, { type: "initialized", time: 70 }).pipe(Effect.exit)),
      ).toBe(true)
    }).pipe(
      Effect.provide(
        fresh((event) =>
          Effect.suspend(() => {
            wire.push(event)
            return wire.length === 1 ? Effect.void : Effect.die("lost receipt")
          }),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(wire).toHaveLength(2)
    await Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      for (const event of wire) yield* events.replay(event)
      expect((yield* db.select().from(ProjectTable).get())?.name).toBe("Unconfirmed")
    }).pipe(Effect.provide(fresh(() => Effect.die("replay must not upload"))), Effect.scoped, Effect.runPromise)
  })

  test("replays a project identity migration without losing metadata or moving unrelated sessions", async () => {
    const wire: EventV2.SerializedEvent[] = []
    const newID = Project.ID.make("new-project-id")
    const otherID = Project.ID.make("other-project-id")
    const ids = [Session.ID.create(), Session.ID.create()]
    const expected = await Effect.gen(function* () {
      const history = yield* ProjectHistory.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      for (const id of [projectID, otherID])
        yield* history.change(id, {
          type: "saved",
          info: { ...info, id },
          openedDirectory: { directory: info.worktree, time: 11 },
        })
      for (const [index, id] of [projectID, otherID].entries()) {
        const sessionID = ids[index]!
        yield* events.publish(SessionV1.Event.Created, {
          sessionID,
          info: Schema.decodeUnknownSync(SessionV1.SessionInfo)({
            id: sessionID,
            projectID: id,
            slug: "migrated",
            directory: info.worktree,
            title: "Project migration",
            version: "test",
            time: { created: 22, updated: 25 },
          }),
        })
      }
      yield* history.change(newID, { type: "migrated", previousID: projectID, time: 70 })
      expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()).toBeUndefined()
      expect((yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, newID)).get())?.commands).toEqual({
        start: "bun dev",
      })
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, ids[0]!)).get())?.time_updated).toBe(25)
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, ids[1]!)).get())?.project_id).toBe(
        otherID,
      )
      return {
        projects: yield* db.select().from(ProjectTable).orderBy(ProjectTable.id).all(),
        sessions: yield* db.select().from(SessionTable).orderBy(SessionTable.id).all(),
        directories: yield* db.select().from(ProjectDirectoryTable).all(),
      }
    }).pipe(
      Effect.provide(
        fresh((event) =>
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
      const { db } = yield* Database.Service
      for (const event of wire) yield* events.replay(event)
      expect(yield* db.select().from(ProjectTable).orderBy(ProjectTable.id).all()).toEqual(expected.projects)
      expect(yield* db.select().from(SessionTable).orderBy(SessionTable.id).all()).toEqual(expected.sessions)
      expect(yield* db.select().from(ProjectDirectoryTable).all()).toEqual(expected.directories)
    }).pipe(Effect.provide(fresh(() => Effect.die("replay must not upload"))), Effect.scoped, Effect.runPromise)
  })

  test("rejects mismatched project identity before remote upload", async () => {
    let uploaded = false
    await Effect.gen(function* () {
      const history = yield* ProjectHistory.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const result = yield* history
        .change(projectID, { type: "saved", info: { ...info, id: Project.ID.make("wrong") } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* db.select().from(ProjectTable).all()).toEqual([])
      expect(yield* db.select().from(EventTable).all()).toEqual([])
      yield* events.check
    }).pipe(
      Effect.provide(
        fresh(() =>
          Effect.sync(() => {
            uploaded = true
          }),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(uploaded).toBe(false)
  })
})
