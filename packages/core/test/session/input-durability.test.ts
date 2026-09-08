import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { EventTable } from "@mongolgpt/core/event/sql"
import { Project } from "@mongolgpt/core/project"
import { ProjectTable } from "@mongolgpt/core/project/sql"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { SessionInput } from "@mongolgpt/core/session/input"
import { SessionEvent } from "@mongolgpt/core/session/event"
import { SessionMessage } from "@mongolgpt/core/session/message"
import { Prompt } from "@mongolgpt/core/session/prompt"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { SessionSchema } from "@mongolgpt/core/session/schema"
import { SessionInputTable, SessionTable } from "@mongolgpt/core/session/sql"
import { tmpdir } from "../fixture/tmpdir"

const layer = (filename: string, options?: EventV2.LayerOptions) =>
  SessionProjector.layer.pipe(
    Layer.provideMerge(EventV2.layerWith(options)),
    Layer.provideMerge(Database.layerFromPath(filename)),
  )

const sessionID = SessionSchema.ID.make("ses_input_durability")
const prompt = Prompt.make({ text: "Keep this admission durable" })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "input-durability",
      directory: "/project",
      title: "Input durability",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const admit = (messageID: SessionMessage.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    return yield* SessionInput.admit(db, events, {
      id: messageID,
      sessionID,
      prompt,
      delivery: "steer",
    })
  })

describe("SessionInput admission durability", () => {
  test("does not accept exact retries while postcommit receipt is pending", async () => {
    await using temp = await tmpdir()
    const messageID = SessionMessage.ID.make("msg_input_postcommit_pending")

    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const firstSucceeded = yield* Deferred.make<void>()
        const secondSucceeded = yield* Deferred.make<void>()
        const journal: EventV2.SerializedEvent[] = []
        const postcommits: EventV2.SerializedEvent[] = []
        const options = {
          journal: {
            append: (event: EventV2.SerializedEvent) =>
              Effect.sync(() => {
                journal.push(event)
              }),
            afterCommit: (event: EventV2.SerializedEvent, nativeCommit: boolean) =>
              Effect.gen(function* () {
                expect(nativeCommit).toBe(false)
                postcommits.push(event)
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return yield* Effect.die(new Error("remote snapshot receipt was lost"))
              }),
          },
        }

        yield* Effect.gen(function* () {
          yield* setup
          const { db } = yield* Database.Service

          const first = yield* admit(messageID).pipe(
            Effect.tap(() => Deferred.succeed(firstSucceeded, undefined)),
            Effect.exit,
            Effect.forkScoped,
          )
          yield* Deferred.await(entered)
          expect(
            yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, messageID)).get(),
          ).toMatchObject({
            id: messageID,
            session_id: sessionID,
            admitted_seq: 0,
            delivery: "steer",
          })

          const second = yield* admit(messageID).pipe(
            Effect.tap(() => Deferred.succeed(secondSucceeded, undefined)),
            Effect.exit,
            Effect.forkScoped,
          )
          yield* Effect.sleep("20 millis")

          expect(yield* Deferred.isDone(firstSucceeded)).toBe(false)
          expect(yield* Deferred.isDone(secondSucceeded)).toBe(false)
          expect(journal).toHaveLength(1)
          expect(postcommits).toHaveLength(1)

          yield* Deferred.succeed(release, undefined)

          expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
          expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true)
          expect(journal).toHaveLength(1)
          expect(postcommits).toHaveLength(1)
        }).pipe(Effect.provide(layer(join(temp.path, "native.sqlite"), options)), Effect.scoped)
      }),
    )
  })

  test("rejects postcommit admission failures after the native row is retained", async () => {
    await using temp = await tmpdir()
    const messageID = SessionMessage.ID.make("msg_input_postcommit_failed")
    const journal: EventV2.SerializedEvent[] = []
    const postcommits: EventV2.SerializedEvent[] = []
    const options = {
      journal: {
        append: (event: EventV2.SerializedEvent) =>
          Effect.sync(() => {
            journal.push(event)
          }),
        afterCommit: (event: EventV2.SerializedEvent, nativeCommit: boolean) =>
          Effect.sync(() => {
            expect(nativeCommit).toBe(false)
            postcommits.push(event)
            throw new Error("remote snapshot receipt was lost")
          }),
      },
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service

        const failed = yield* admit(messageID).pipe(Effect.exit)

        expect(Exit.isFailure(failed)).toBe(true)
        expect(journal).toHaveLength(1)
        expect(postcommits).toHaveLength(1)
        expect(postcommits[0]).toMatchObject({
          aggregateID: sessionID,
          seq: 0,
          type: EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1),
        })
        expect(
          yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, messageID)).get(),
        ).toMatchObject({
          id: messageID,
          session_id: sessionID,
          admitted_seq: 0,
          delivery: "steer",
        })
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toHaveLength(1)
        expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)

        const retried = yield* admit(messageID).pipe(Effect.exit)

        expect(Exit.isFailure(retried)).toBe(true)
        expect(journal).toHaveLength(1)
        expect(postcommits).toHaveLength(1)
      }).pipe(Effect.provide(layer(join(temp.path, "native.sqlite"), options)), Effect.scoped),
    )
  })

  test("keeps healthy local exact retries idempotent", async () => {
    await using temp = await tmpdir()
    const messageID = SessionMessage.ID.make("msg_input_local_retry")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        const { db } = yield* Database.Service

        const first = yield* admit(messageID)
        const retried = yield* admit(messageID)

        expect(retried).toEqual(first)
        expect(
          yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, messageID)).all(),
        ).toHaveLength(1)
        expect(
          yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)))
            .all(),
        ).toHaveLength(1)
      }).pipe(Effect.provide(layer(join(temp.path, "native.sqlite"))), Effect.scoped),
    )
  })

  test("reconciles healthy concurrent exact retry lifecycle conflicts", async () => {
    await using temp = await tmpdir()
    const messageID = SessionMessage.ID.make("msg_input_concurrent_retry")

    await Effect.runPromise(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>()
        let checks = 0
        const options = {
          admission: Effect.gen(function* () {
            checks++
            if (checks === 2) yield* Deferred.succeed(release, undefined)
            yield* Deferred.await(release)
          }),
        }

        yield* Effect.gen(function* () {
          yield* setup
          const { db } = yield* Database.Service

          const admitted = yield* Effect.all([admit(messageID), admit(messageID)], { concurrency: "unbounded" })

          expect(admitted[1]).toEqual(admitted[0])
          expect(
            yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, messageID)).all(),
          ).toHaveLength(1)
          expect(
            yield* db
              .select()
              .from(EventTable)
              .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)))
              .all(),
          ).toHaveLength(1)
        }).pipe(Effect.provide(layer(join(temp.path, "native.sqlite"), options)), Effect.scoped)
      }),
    )
  })
})
