import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { EventTable } from "@mongolgpt/core/event/sql"
import { Location } from "@mongolgpt/core/location"
import { locationServiceMapLayer } from "@mongolgpt/core/location-services"
import { ProjectV2 } from "@mongolgpt/core/project"
import { ProjectHistory } from "@mongolgpt/core/project/history"
import { ProjectDirectoryTable, ProjectTable } from "@mongolgpt/core/project/sql"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { SessionV2 } from "@mongolgpt/core/session"
import { SessionExecution } from "@mongolgpt/core/session/execution"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { SessionTable } from "@mongolgpt/core/session/sql"
import { SessionStore } from "@mongolgpt/core/session/store"
import { SessionV1 } from "@mongolgpt/core/v1/session"
import type { Scope } from "effect/Scope"

const projectID = ProjectV2.ID.make("project-session-history")
const previousProjectID = ProjectV2.ID.make("project-session-history-previous")
const otherProjectID = ProjectV2.ID.make("project-session-history-other")
const worktree = AbsolutePath.make("/workspace/repo")
const otherWorktree = AbsolutePath.make("/workspace/other")
const location = Location.Ref.make({ directory: AbsolutePath.make("/workspace/repo/app") })
const otherLocation = Location.Ref.make({ directory: AbsolutePath.make("/workspace/other/app") })
const projectEventType = EventV2.versionedType(ProjectHistory.Changed.type, 1)
const sessionCreatedType = EventV2.versionedType(SessionV1.Event.Created.type, 1)

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionV2.Service | Database.Service | EventV2.Service | Scope>,
  input: {
    readonly append?: (event: EventV2.SerializedEvent) => Effect.Effect<void>
    readonly previous?: ProjectV2.ID
    readonly resolved?: AbsolutePath[]
  } = {},
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(sourceLayer(input))))

function sourceLayer(input: {
  readonly append?: (event: EventV2.SerializedEvent) => Effect.Effect<void>
  readonly previous?: ProjectV2.ID
  readonly resolved?: AbsolutePath[]
}) {
  const projects = Layer.succeed(
    ProjectV2.Service,
    ProjectV2.Service.of({
      resolve: (directory) =>
        Effect.sync(() => {
          input.resolved?.push(directory)
          if (directory === otherLocation.directory)
            return { id: otherProjectID, directory: otherWorktree, vcs: { type: "git" as const, store: otherWorktree } }
          return {
            id: projectID,
            previous: input.previous,
            directory: worktree,
            vcs: { type: "git" as const, store: worktree },
          }
        }),
      directories: () => Effect.succeed([]),
      commit: () => Effect.void,
    }),
  )
  const sessions = SessionV2.layer.pipe(
    Layer.provide(locationServiceMapLayer),
    Layer.provide(SessionStore.layer),
    Layer.provide(SessionExecution.noopLayer),
    Layer.provide(projects),
  )
  return Layer.mergeAll(sessions, SessionProjector.layer).pipe(
    Layer.provideMerge(
      EventV2.layerWith({
        requireProjectors: true,
        ...(input.append ? { journal: { append: input.append } } : {}),
      }),
    ),
    Layer.provideMerge(Database.defaultLayer),
  )
}

function replayLayer() {
  return Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
    Layer.provideMerge(
      EventV2.layerWith({
        requireProjectors: true,
        journal: { append: () => Effect.die("replay must not upload") },
      }),
    ),
    Layer.provideMerge(Database.defaultLayer),
  )
}

describe("SessionV2 project history prerequisite", () => {
  test("journals a fresh project before the session and replays into an empty projection", async () => {
    const envelopes: EventV2.SerializedEvent[] = []
    const sessionID = SessionV2.ID.make("ses_project_history_fresh")
    const created = await run(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        return yield* session.create({ id: sessionID, location })
      }),
      {
        append: (event) =>
          Effect.sync(() => {
            envelopes.push(event)
          }),
      },
    )

    expect(created.projectID).toBe(projectID)
    expect(envelopes.map((event) => event.type)).toEqual([projectEventType, sessionCreatedType])
    expect(envelopes.map((event) => event.aggregateID)).toEqual([projectID, sessionID])
    expect((envelopes[0]?.data as EventV2.Data<typeof ProjectHistory.Changed>).change).toMatchObject({
      type: "saved",
      info: { id: projectID, worktree, vcs: "git", sandboxes: [] },
      openedDirectory: { directory: location.directory },
    })

    await Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      expect(yield* db.select().from(ProjectTable).all()).toEqual([])
      expect(yield* db.select().from(SessionTable).all()).toEqual([])
      for (const event of JSON.parse(JSON.stringify(envelopes)) as EventV2.SerializedEvent[]) {
        yield* events.replay(event)
      }
      expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()).toMatchObject({
        id: projectID,
        worktree,
        vcs: "git",
        sandboxes: [],
      })
      expect(yield* db.select().from(ProjectDirectoryTable).all()).toMatchObject([
        { project_id: projectID, directory: location.directory },
      ])
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        id: sessionID,
        project_id: projectID,
        directory: location.directory,
      })
      expect(yield* db.select().from(EventTable).all()).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(replayLayer()), Effect.runPromise)
  })

  test("does not publish the session when the project journal acknowledgement is uncertain", async () => {
    const envelopes: EventV2.SerializedEvent[] = []
    const exit = await run(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const db = (yield* Database.Service).db
        const result = yield* session
          .create({ id: SessionV2.ID.make("ses_project_history_uncertain"), location })
          .pipe(Effect.exit)
        expect(yield* db.select().from(ProjectTable).all()).toEqual([])
        expect(yield* db.select().from(SessionTable).all()).toEqual([])
        expect(yield* db.select().from(EventTable).all()).toEqual([])
        return result
      }),
      {
        append: (event) =>
          Effect.sync(() => {
            envelopes.push(event)
            if (event.type === projectEventType) throw new Error("lost project receipt")
          }),
      },
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(envelopes.map((event) => event.type)).toEqual([projectEventType])
  })

  test("baselines an existing project without overwriting its metadata", async () => {
    const envelopes: EventV2.SerializedEvent[] = []
    const existing = {
      id: projectID,
      worktree,
      vcs: "git",
      name: "Existing project",
      icon_url: "data:image/png;base64,Yg==",
      icon_url_override: "custom-existing",
      icon_color: "teal",
      commands: { start: "bun run existing" },
      time_created: 11,
      time_updated: 22,
      time_initialized: 15,
      sandboxes: [AbsolutePath.make("/workspace/repo-copy")],
    }

    await run(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const db = (yield* Database.Service).db
        yield* db.insert(ProjectTable).values(existing).run()
        yield* db
          .insert(ProjectDirectoryTable)
          .values({
            project_id: projectID,
            directory: worktree,
            type: "main",
            strategy: "manual",
            time_created: 12,
          })
          .run()

        yield* session.create({ id: SessionV2.ID.make("ses_project_history_existing"), location })

        expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()).toEqual(existing)
      }),
      {
        append: (event) =>
          Effect.sync(() => {
            envelopes.push(event)
          }),
      },
    )

    expect(envelopes.map((event) => event.type)).toEqual([projectEventType, sessionCreatedType])
    expect((envelopes[0]?.data as EventV2.Data<typeof ProjectHistory.Changed>).change).toMatchObject({
      type: "saved",
      info: {
        id: projectID,
        name: "Existing project",
        icon: { url: "data:image/png;base64,Yg==", override: "custom-existing", color: "teal" },
        commands: { start: "bun run existing" },
        time: { created: 11, updated: 22, initialized: 15 },
        sandboxes: ["/workspace/repo-copy"],
      },
      directories: [{ directory: worktree, type: "main", strategy: "manual", time: 12 }],
    })
  })

  test("migrates a resolved previous project before publishing the session", async () => {
    const envelopes: EventV2.SerializedEvent[] = []
    const sessionID = SessionV2.ID.make("ses_project_history_migrated")
    const previous = {
      id: previousProjectID,
      worktree,
      vcs: "git",
      name: "Previous project",
      icon_url: null,
      icon_url_override: null,
      icon_color: "amber",
      commands: { start: "bun run previous" },
      time_created: 31,
      time_updated: 42,
      time_initialized: null,
      sandboxes: [AbsolutePath.make("/workspace/previous-copy")],
    }

    await run(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const db = (yield* Database.Service).db
        yield* db.insert(ProjectTable).values(previous).run()
        yield* db
          .insert(ProjectDirectoryTable)
          .values({
            project_id: previousProjectID,
            directory: worktree,
            type: "main",
            strategy: "previous",
            time_created: 33,
          })
          .run()

        yield* session.create({ id: sessionID, location })

        expect(
          yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, previousProjectID)).get(),
        ).toBeUndefined()
        expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()).toMatchObject({
          id: projectID,
          name: "Previous project",
          icon_color: "amber",
          commands: { start: "bun run previous" },
          time_created: 31,
          sandboxes: [AbsolutePath.make("/workspace/previous-copy")],
        })
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
          id: sessionID,
          project_id: projectID,
        })
      }),
      {
        append: (event) =>
          Effect.sync(() => {
            envelopes.push(event)
          }),
        previous: previousProjectID,
      },
    )

    expect(envelopes.map((event) => event.type)).toEqual([projectEventType, projectEventType, sessionCreatedType])
    expect(envelopes.map((event) => event.aggregateID)).toEqual([previousProjectID, projectID, sessionID])
    expect((envelopes[0]?.data as EventV2.Data<typeof ProjectHistory.Changed>).change).toMatchObject({
      type: "saved",
      info: { id: previousProjectID, name: "Previous project" },
      directories: [{ directory: worktree, type: "main", strategy: "previous", time: 33 }],
    })
    expect((envelopes[1]?.data as EventV2.Data<typeof ProjectHistory.Changed>).change).toMatchObject({
      type: "migrated",
      previousID: previousProjectID,
    })

    await Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      for (const event of JSON.parse(JSON.stringify(envelopes)) as EventV2.SerializedEvent[]) {
        yield* events.replay(event)
      }
      expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, previousProjectID)).get()).toBeUndefined()
      expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()).toMatchObject({
        id: projectID,
        name: "Previous project",
        commands: { start: "bun run previous" },
      })
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        id: sessionID,
        project_id: projectID,
      })
    }).pipe(Effect.scoped, Effect.provide(replayLayer()), Effect.runPromise)
  })

  test("recreates a resolved project after its earlier aggregate migrated away", async () => {
    const envelopes: EventV2.SerializedEvent[] = []
    const sessionID = SessionV2.ID.make("ses_project_history_remigrated_old")

    await run(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const db = (yield* Database.Service).db

        yield* events.publish(ProjectHistory.Changed, {
          projectID,
          change: {
            type: "saved",
            info: {
              id: projectID,
              worktree,
              vcs: "git",
              name: "Original A",
              commands: { start: "bun run a" },
              time: { created: 10, updated: 20 },
              sandboxes: [],
            },
          },
        })
        yield* events.publish(ProjectHistory.Changed, {
          projectID: otherProjectID,
          change: { type: "migrated", previousID: projectID, time: 30 },
        })
        expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()).toBeUndefined()
        expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, otherProjectID)).get()).toMatchObject({
          id: otherProjectID,
          name: "Original A",
          commands: { start: "bun run a" },
        })

        yield* session.create({ id: sessionID, location })

        expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()).toMatchObject({
          id: projectID,
          worktree,
          vcs: "git",
          name: null,
          commands: null,
          sandboxes: [],
        })
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
          id: sessionID,
          project_id: projectID,
        })
      }),
      {
        append: (event) =>
          Effect.sync(() => {
            envelopes.push(event)
          }),
      },
    )

    expect(envelopes.map((event) => event.type)).toEqual([
      projectEventType,
      projectEventType,
      projectEventType,
      sessionCreatedType,
    ])
    expect(envelopes.map((event) => event.aggregateID)).toEqual([projectID, otherProjectID, projectID, sessionID])
    expect(envelopes.map((event) => event.seq)).toEqual([0, 0, 1, 0])
    expect((envelopes[2]?.data as EventV2.Data<typeof ProjectHistory.Changed>).change).toMatchObject({
      type: "saved",
      info: { id: projectID, worktree, vcs: "git", sandboxes: [] },
      openedDirectory: { directory: location.directory },
    })

    await Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      for (const event of JSON.parse(JSON.stringify(envelopes)) as EventV2.SerializedEvent[]) {
        yield* events.replay(event)
      }
      expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, otherProjectID)).get()).toMatchObject({
        id: otherProjectID,
        name: "Original A",
        commands: { start: "bun run a" },
      })
      expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()).toMatchObject({
        id: projectID,
        worktree,
        vcs: "git",
        commands: null,
      })
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        id: sessionID,
        project_id: projectID,
      })
    }).pipe(Effect.scoped, Effect.provide(replayLayer()), Effect.runPromise)
  })

  test("keeps local no-journal creation behavior", async () => {
    await run(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const db = (yield* Database.Service).db
        const created = yield* session.create({ id: SessionV2.ID.make("ses_project_history_local"), location })

        expect(created).toMatchObject({ projectID, location })
        expect(yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()).toMatchObject({
          id: projectID,
          worktree,
          vcs: "git",
        })
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).get()).toMatchObject({
          id: created.id,
          project_id: projectID,
        })
      }),
    )
  })

  test("adopts an existing session ID without resolving or journaling a second project", async () => {
    const envelopes: EventV2.SerializedEvent[] = []
    const resolved: AbsolutePath[] = []
    const sessionID = SessionV2.ID.make("ses_project_history_adopt")
    await run(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const created = yield* session.create({ id: sessionID, location })
        const adopted = yield* session.create({ id: sessionID, location: otherLocation })

        expect(adopted).toEqual(created)
      }),
      {
        append: (event) =>
          Effect.sync(() => {
            envelopes.push(event)
          }),
        resolved,
      },
    )

    expect(resolved).toEqual([location.directory])
    expect(envelopes.map((event) => event.type)).toEqual([projectEventType, sessionCreatedType])
    expect(envelopes.map((event) => event.aggregateID)).toEqual([projectID, sessionID])
  })

  test("serializes concurrent exact creates behind one project prerequisite", async () => {
    const envelopes: EventV2.SerializedEvent[] = []
    const entered = await Effect.runPromise(Deferred.make<void>())
    const receipt = await Effect.runPromise(Deferred.make<void>())
    const sessionID = SessionV2.ID.make("ses_project_history_concurrent")

    await run(
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const first = yield* session.create({ id: sessionID, location }).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        const second = yield* session.create({ id: sessionID, location }).pipe(Effect.forkScoped)
        yield* Deferred.succeed(receipt, undefined)
        const created = yield* Fiber.join(first)
        const retried = yield* Fiber.join(second)

        expect(retried).toEqual(created)
      }),
      {
        append: (event) =>
          Effect.sync(() => {
            envelopes.push(event)
          }).pipe(
            Effect.andThen(event.type === projectEventType ? Deferred.succeed(entered, undefined) : Effect.void),
            Effect.andThen(event.type === projectEventType ? Deferred.await(receipt) : Effect.void),
          ),
      },
    )

    expect(envelopes.map((event) => event.type)).toEqual([projectEventType, sessionCreatedType])
    expect(envelopes.map((event) => event.aggregateID)).toEqual([projectID, sessionID])
  })
})
