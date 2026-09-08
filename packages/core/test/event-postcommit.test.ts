import { expect, test } from "bun:test"
import { join } from "node:path"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { Database } from "@mongolgpt/core/database/database"
import { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { EventV2 } from "@mongolgpt/core/event"
import { Session } from "@mongolgpt/schema/session"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { tmpdir } from "./fixture/tmpdir"

const definition = SessionV1.Event.MessageRemoved
const aggregateID = Session.ID.make("ses_postcommit")
const payload = (name: string) => ({ sessionID: aggregateID, messageID: SessionV1.MessageID.make(`msg_${name}`) })

test("postcommit snapshot includes native rows and blocks writers, listeners and late durable subscribers until receipt", async () => {
  await using temp = await tmpdir()
  const filename = join(temp.path, "native.sqlite")
  const key = Buffer.alloc(32, 3)
  const destination = join(temp.path, "native.backup")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const appended: string[] = []
  const notified: string[] = []
  const observed: string[] = []
  let finished = false
  let calls = 0
  const layer = EventV2.layerWith({
    journal: {
      append: (event) =>
        Effect.sync(() => {
          appended.push(String(event.id))
        }),
      afterCommit: (event, nativeCommit) =>
        Effect.gen(function* () {
          if (++calls !== 1) return
          expect(nativeCommit).toBe(true)
          const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
          const committed = new sqlite.Database(filename, { readonly: true })
          try {
            expect(committed.query("SELECT id FROM event").all()).toEqual([{ id: event.id }])
            expect(committed.query("SELECT value FROM native_state ORDER BY value").all()).toEqual([
              { value: "operational" },
              { value: "projected" },
            ])
          } finally {
            committed.close()
          }
          yield* DatabaseBackup.create({ source: filename, destination, key }).pipe(Effect.orDie)
          entered.resolve()
          yield* Effect.promise(() => release.promise)
        }),
    },
  }).pipe(Layer.provideMerge(Database.layerFromPath(filename)))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        yield* db.run("CREATE TABLE native_state (value TEXT NOT NULL)").pipe(Effect.orDie)
        yield* events.project(definition, () =>
          db.run("INSERT INTO native_state VALUES ('projected')").pipe(Effect.asVoid, Effect.orDie),
        )
        yield* events.listen((event) =>
          Effect.sync(() => {
            notified.push(String(event.id))
          }),
        )
        const first = yield* events
          .publish(definition, payload("first"), {
            id: EventV2.ID.make("evt_first"),
            commit: () => db.run("INSERT INTO native_state VALUES ('operational')").pipe(Effect.asVoid, Effect.orDie),
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                finished = true
              }),
            ),
            Effect.forkScoped,
          )
        yield* Effect.promise(() => entered.promise)
        const late = yield* events.durable({ aggregateID }).pipe(
          Stream.take(2),
          Stream.tap((event) =>
            Effect.sync(() => {
              observed.push(String(event.id))
            }),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        )
        const second = yield* events
          .publish(definition, payload("second"), { id: EventV2.ID.make("evt_second") })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep("20 millis")
        expect(appended).toEqual(["evt_first"])
        expect(notified).toEqual([])
        expect(observed).toEqual([])
        expect(finished).toBe(false)
        release.resolve()
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        yield* Fiber.join(late)
        expect(appended).toEqual(["evt_first", "evt_second"])
        expect(notified).toEqual(["evt_first", "evt_second"])
        expect(observed).toEqual(["evt_first", "evt_second"])
        expect(calls).toBe(2)
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    const restored = join(temp.path, "restored.sqlite")
    await Effect.runPromise(DatabaseBackup.restore({ source: destination, destination: restored, key }))
    const sqlite = await import("bun:sqlite")
    const database = new sqlite.Database(restored, { readonly: true })
    try {
      expect(database.query("SELECT id FROM event").all()).toEqual([{ id: "evt_first" }])
      expect(database.query("SELECT value FROM native_state ORDER BY value").all()).toEqual([
        { value: "operational" },
        { value: "projected" },
      ])
    } finally {
      database.close()
    }
  } finally {
    release.resolve()
    key.fill(0)
  }
}, 30_000)

test("uncertain postcommit receipt keeps local data but fences queued writers and late reads without notifying", async () => {
  await using temp = await tmpdir()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const appended: string[] = []
  const notified: string[] = []
  const layer = EventV2.layerWith({
    journal: {
      append: (event) =>
        Effect.sync(() => {
          appended.push(String(event.id))
        }),
      afterCommit: () =>
        Effect.promise(async () => {
          entered.resolve()
          await release.promise
          throw new Error("private receipt failure")
        }),
    },
  }).pipe(Layer.provideMerge(Database.layerFromPath(join(temp.path, "native.sqlite"))))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        yield* events.listen((event) =>
          Effect.sync(() => {
            notified.push(String(event.id))
          }),
        )
        const first = yield* events
          .publish(definition, payload("first"), { id: EventV2.ID.make("evt_first") })
          .pipe(Effect.exit, Effect.forkScoped)
        yield* Effect.promise(() => entered.promise)
        const second = yield* events
          .publish(definition, payload("second"), { id: EventV2.ID.make("evt_second") })
          .pipe(Effect.exit, Effect.forkScoped)
        const late = yield* events
          .durable({ aggregateID })
          .pipe(Stream.take(1), Stream.runCollect, Effect.exit, Effect.forkScoped)
        yield* Effect.sleep("20 millis")
        release.resolve()
        expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
        expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true)
        expect(Exit.isFailure(yield* Fiber.join(late))).toBe(true)
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
        expect(appended).toEqual(["evt_first"])
        expect(notified).toEqual([])
        expect(yield* db.all<{ id: string }>("SELECT id FROM event").pipe(Effect.orDie)).toEqual([{ id: "evt_first" }])
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  } finally {
    release.resolve()
  }
})

test("a local COMMIT failure after append rolls back and never invokes the postcommit hook", async () => {
  await using temp = await tmpdir()
  let appended = 0
  let checkpointed = 0
  const layer = EventV2.layerWith({
    journal: {
      append: () =>
        Effect.sync(() => {
          appended++
        }),
      afterCommit: () =>
        Effect.sync(() => {
          checkpointed++
        }),
    },
  }).pipe(Layer.provideMerge(Database.layerFromPath(join(temp.path, "native.sqlite"))))
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY)").pipe(Effect.orDie)
      yield* db
        .run("CREATE TABLE child (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)")
        .pipe(Effect.orDie)
      const result = yield* events
        .publish(definition, payload("broken"), {
          commit: () => db.run("INSERT INTO child VALUES (9)").pipe(Effect.asVoid, Effect.orDie),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(appended).toBe(1)
      expect(checkpointed).toBe(0)
      expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
      expect(yield* db.all("SELECT * FROM event").pipe(Effect.orDie)).toEqual([])
      expect(yield* db.all("SELECT * FROM child").pipe(Effect.orDie)).toEqual([])
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
})

test("synchronous postcommit hook failures are fenced too", async () => {
  await using temp = await tmpdir()
  const layer = EventV2.layerWith({
    journal: {
      append: () => Effect.void,
      afterCommit: () => {
        throw new Error("private synchronous failure")
      },
    },
  }).pipe(Layer.provideMerge(Database.layerFromPath(join(temp.path, "native.sqlite"))))
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      expect(Exit.isFailure(yield* events.publish(definition, payload("broken")).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
})

test("interrupting a pending postcommit aborts the receipt and fences retained data", async () => {
  await using temp = await tmpdir()
  const entered = Promise.withResolvers<AbortSignal>()
  let appended = 0
  let notified = 0
  const layer = EventV2.layerWith({
    journal: {
      append: () =>
        Effect.sync(() => {
          appended++
        }),
      afterCommit: () =>
        Effect.promise((signal) => {
          entered.resolve(signal)
          return new Promise<void>(() => {})
        }),
    },
  }).pipe(Layer.provideMerge(Database.layerFromPath(join(temp.path, "native.sqlite"))))
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.listen(() =>
        Effect.sync(() => {
          notified++
        }),
      )
      const first = yield* events.publish(definition, payload("interrupted")).pipe(Effect.exit, Effect.forkScoped)
      const signal = yield* Effect.promise(() => entered.promise)
      const queued = yield* events.publish(definition, payload("queued")).pipe(Effect.exit, Effect.forkScoped)
      yield* Fiber.interrupt(first)
      expect(signal.aborted).toBe(true)
      expect(Exit.isFailure(yield* Fiber.join(queued))).toBe(true)
      expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
      expect(appended).toBe(1)
      expect(notified).toBe(0)
      expect(yield* db.all("SELECT id FROM event").pipe(Effect.orDie)).toHaveLength(1)
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
})

test("replay never republishes a journal entry or requests a new native snapshot", async () => {
  await using temp = await tmpdir()
  const layer = EventV2.layerWith({
    journal: {
      append: () => Effect.die("replay must not append"),
      afterCommit: () => Effect.die("replay must not capture"),
    },
  }).pipe(Layer.provideMerge(Database.layerFromPath(join(temp.path, "native.sqlite"))))
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.replay({
        id: EventV2.ID.make("evt_replayed"),
        aggregateID,
        seq: 0,
        type: EventV2.versionedType(definition.type, definition.durable!.version),
        data: payload("replayed"),
      })
      yield* events.check
      expect(yield* db.all<{ id: string }>("SELECT id FROM event").pipe(Effect.orDie)).toEqual([{ id: "evt_replayed" }])
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
})

test("nested cloud publications fail before acquiring the postcommit gate", async () => {
  await using temp = await tmpdir()
  let appended = 0
  const layer = EventV2.layerWith({
    journal: {
      append: () =>
        Effect.sync(() => {
          appended++
        }),
      afterCommit: () => Effect.void,
    },
  }).pipe(Layer.provideMerge(Database.layerFromPath(join(temp.path, "native.sqlite"))))
  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const nested = yield* events
        .publish(definition, payload("outer"), {
          commit: () => events.publish(definition, payload("nested")).pipe(Effect.asVoid),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(nested)).toBe(true)
      expect(appended).toBe(0)
      expect(yield* db.all("SELECT id FROM event").pipe(Effect.orDie)).toEqual([])
      yield* events.publish(definition, payload("healthy"))
      expect(appended).toBe(1)
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
})
