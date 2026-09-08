import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Exit, Layer, Schema } from "effect"
import { DatabaseCheckpoint } from "@mongolgpt/core/database/checkpoint"
import { Database } from "@mongolgpt/core/database/database"
import { EventV2 } from "@mongolgpt/core/event"
import { createCloudHistory } from "@mongolgpt/core/event/cloud-history"
import { createCloudRecovery } from "@mongolgpt/core/event/cloud-recovery"
import { CloudHistoryTombstoneTable } from "@mongolgpt/core/event/cloud-history.sql"
import { EventSequenceTable, EventTable } from "@mongolgpt/core/event/sql"
import { ProjectHistory } from "@mongolgpt/core/project/history"
import { ProjectTable } from "@mongolgpt/core/project/sql"
import { SessionProjector } from "@mongolgpt/core/session/projector"
import { MessageTable, PartTable, SessionTable } from "@mongolgpt/core/session/sql"
import { SessionV1 } from "@mongolgpt/core/v1/session"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { Project } from "@mongolgpt/schema/project"
import { Session } from "@mongolgpt/schema/session"
import { tmpdir } from "./fixture/tmpdir"

const checkpointID = "33333333-3333-4333-8333-333333333333"
const projectA = Project.ID.make("project_resume_a")
const projectB = Project.ID.make("project_resume_b")
const sessionA = Session.ID.make("ses_resume_a")
const sessionB = Session.ID.make("ses_resume_b")
const baselineMessage = SessionV1.MessageID.make("msg_resume_baseline")
const deltaMessage = SessionV1.MessageID.make("msg_resume_delta")
const extraMessage = SessionV1.MessageID.make("msg_resume_extra")

const ids = {
  projectA: EventV2.ID.make("evt_resume_project_a"),
  sessionA: EventV2.ID.make("evt_resume_session_a"),
  messageA: EventV2.ID.make("evt_resume_message_a"),
  projectB: EventV2.ID.make("evt_resume_project_b"),
  sessionB: EventV2.ID.make("evt_resume_session_b"),
  delta: EventV2.ID.make("evt_resume_delta"),
  extra: EventV2.ID.make("evt_resume_extra"),
  deleted: EventV2.ID.make("evt_resume_deleted"),
}

type Entry =
  | { cursor: number; deleted: false; event: EventV2.SerializedEvent }
  | { cursor: number; deleted: true; aggregateID: string; id: EventV2.ID; seq: number }

const layers = (filename: string, options?: EventV2.LayerOptions) =>
  Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
    Layer.provideMerge(EventV2.layerWith(options)),
    Layer.provideMerge(Database.layerFromPath(filename)),
  )

describe("native same-container cloud history resume recovery", () => {
  test("resumes from a validated prefix, replays durable cloud delta idempotently, and preserves native rows", async () => {
    await using temp = await tmpdir()
    const fixture = await resumeFixture(temp.path)
    const { recovery, calls } = cloudFixture(fixture.delta, fixture.checkpoint)

    await withDatabase(
      fixture.resume,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        yield* events.recover
        yield* events.check

        expect(calls).toEqual(["/v1/epoch", "/v1/claim", "/v1/read", "/v1/read"])
        expect(yield* db.select().from(EventTable).all()).toHaveLength(6)
        expect(yield* db.select().from(ProjectTable).all()).toHaveLength(2)
        expect(yield* db.select().from(SessionTable).all()).toHaveLength(2)
        expect(yield* db.select().from(MessageTable).all()).toHaveLength(2)
        expect(yield* db.select().from(PartTable).all()).toEqual([])
        expect(yield* db.all(sql`SELECT email FROM account`)).toEqual([{ email: "resume@example.test" }])
        expect(yield* db.all(sql`SELECT id, delivery FROM session_input`)).toEqual([
          { id: "msg_resume_pending", delivery: "queue" },
        ])
      }),
      recovery.eventOptions,
    )
  })

  test("allows a missing baseline aggregate only with a remote deletion guard", async () => {
    await using temp = await tmpdir()
    const fixture = await baselineFixture(temp.path)
    await seedResume(fixture.resume, fixture.baseline)
    const tombstone = { cursor: 1, deleted: true as const, aggregateID: sessionA, id: ids.deleted, seq: 3 }
    await eraseLocalSession(fixture.resume, tombstone)
    const { recovery } = cloudFixture([tombstone], fixture.checkpoint)

    await withDatabase(
      fixture.resume,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        yield* events.recover
        expect(yield* db.select().from(SessionTable).all()).toEqual([])
        expect(yield* db.select().from(EventTable).all()).toHaveLength(1)
        expect(yield* db.select().from(CloudHistoryTombstoneTable).all()).toEqual([
          { aggregate_id: sessionA, event_id: ids.deleted, seq: 3 },
        ])
      }),
      recovery.eventOptions,
    )
  })

  test("refuses resume without a baseline", () => {
    expect(() => createCloudRecovery(createCloudHistory(), undefined, { resume: true })).toThrow()
  })

  test("fails closed on tampered checkpoint prefix content", async () => {
    await using temp = await tmpdir()
    const fixture = await resumeFixture(temp.path)
    await mutate(fixture.resume, (db) =>
      db.query("UPDATE event SET data = json_set(data, '$.info.system', ?) WHERE id = ?").run("tampered", ids.messageA),
    )
    const input = cloudFixture(fixture.delta, fixture.checkpoint)

    await expectFailure(fixture.resume, input)
  })

  test("fails closed when baseline rows are missing without an authenticated deletion", async () => {
    await using temp = await tmpdir()
    const fixture = await resumeFixture(temp.path)
    await withDatabase(
      fixture.resume,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .delete(EventTable)
          .where(sql`${EventTable.aggregate_id} = ${sessionA}`)
          .run()
        yield* db
          .delete(EventSequenceTable)
          .where(sql`${EventSequenceTable.aggregate_id} = ${sessionA}`)
          .run()
      }),
    )
    const input = cloudFixture(fixture.delta, fixture.checkpoint)

    await expectFailure(fixture.resume, input)
  })

  for (const [name, mutation] of [
    [
      "delta content with a reused event ID",
      (db: import("bun:sqlite").Database) =>
        db
          .query("UPDATE event SET data = json_set(data, '$.info.system', ?) WHERE id = ?")
          .run("forged delta", ids.delta),
    ],
    [
      "baseline session moved to a different project",
      (db: import("bun:sqlite").Database) =>
        db.query("UPDATE session SET project_id = ? WHERE id = ?").run(projectB, sessionA),
    ],
    [
      "delta session moved to a different project",
      (db: import("bun:sqlite").Database) =>
        db.query("UPDATE session SET project_id = ? WHERE id = ?").run(projectA, sessionB),
    ],
    [
      "forged event sequence head",
      (db: import("bun:sqlite").Database) =>
        db.query("UPDATE event_sequence SET seq = seq + 1 WHERE aggregate_id = ?").run(sessionA),
    ],
  ] as const) {
    test(`fails closed on ${name}`, async () => {
      await using temp = await tmpdir()
      const fixture = await resumeFixture(temp.path)
      await mutate(fixture.resume, mutation)
      await expectFailure(fixture.resume, cloudFixture(fixture.delta, fixture.checkpoint))
    })
  }

  test("fails closed on local durable events that are not acknowledged by baseline or remote history", async () => {
    await using temp = await tmpdir()
    const fixture = await resumeFixture(temp.path)
    await appendExtraLocalEvent(fixture.resume)
    const input = cloudFixture(fixture.delta, fixture.checkpoint)

    await expectFailure(fixture.resume, input)
  })

  test("fails closed on forged local deletion without a remote deletion guard", async () => {
    await using temp = await tmpdir()
    const fixture = await baselineFixture(temp.path)
    await seedResume(fixture.resume, fixture.baseline)
    await eraseLocalSession(fixture.resume, { aggregateID: sessionA, id: ids.deleted, seq: 3 })
    const input = cloudFixture([], fixture.checkpoint)

    await expectFailure(fixture.resume, input)
  })
})

async function resumeFixture(root: string) {
  const fixture = await baselineFixture(root)
  const delta = await deltaEvents(join(root, "delta.sqlite"), fixture.baseline)
  await seedResume(fixture.resume, [...fixture.baseline, ...delta])
  await preserveNativeRows(fixture.resume)
  return { ...fixture, delta: pageEntries(delta) }
}

async function baselineFixture(root: string) {
  await mkdir(root, { recursive: true })
  const baselinePath = join(root, "baseline.sqlite")
  const resume = join(root, "resume.sqlite")
  const baseline = await baselineEvents(baselinePath)
  const inventory = await inspectInventory(baselinePath)
  const checkpoint: CloudCheckpoint.Checkpoint = {
    id: checkpointID,
    inventory,
    sqlite: archive("1"),
    files: archive("2"),
  }
  return { baseline, checkpoint, resume }
}

async function baselineEvents(filename: string) {
  const wire: EventV2.SerializedEvent[] = []
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* events.publish(
        ProjectHistory.Changed,
        {
          projectID: projectA,
          change: {
            type: "saved",
            info: {
              id: projectA,
              worktree: "/resume/a",
              name: "Resume A",
              time: { created: 1000, updated: 1001 },
              sandboxes: [],
            },
          },
        },
        { id: ids.projectA },
      )
      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: sessionA, info: sessionInfo(sessionA, projectA, "a") },
        { id: ids.sessionA },
      )
      yield* events.publish(
        SessionV1.Event.MessageUpdated,
        {
          sessionID: sessionA,
          info: Schema.decodeUnknownSync(SessionV1.Info)({
            id: baselineMessage,
            sessionID: sessionA,
            role: "user",
            time: { created: 2002 },
            agent: "build",
            model: { providerID: "opencode", modelID: "resume-model" },
            system: "baseline",
          }),
        },
        { id: ids.messageA },
      )
    }),
    {
      journal: {
        append: (event) =>
          Effect.sync(() => {
            wire.push(event)
          }),
      },
    },
  )
  return wire
}

async function deltaEvents(filename: string, baseline: EventV2.SerializedEvent[]) {
  const wire: EventV2.SerializedEvent[] = []
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      for (const event of baseline) yield* events.replay(event)
      yield* events.publish(
        ProjectHistory.Changed,
        {
          projectID: projectB,
          change: {
            type: "saved",
            info: {
              id: projectB,
              worktree: "/resume/b",
              name: "Resume B",
              time: { created: 3000, updated: 3001 },
              sandboxes: [],
            },
          },
        },
        { id: ids.projectB },
      )
      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: sessionB, info: sessionInfo(sessionB, projectB, "b") },
        { id: ids.sessionB },
      )
      yield* events.publish(
        SessionV1.Event.MessageUpdated,
        {
          sessionID: sessionA,
          info: Schema.decodeUnknownSync(SessionV1.Info)({
            id: deltaMessage,
            sessionID: sessionA,
            role: "user",
            time: { created: 3002 },
            agent: "build",
            model: { providerID: "opencode", modelID: "resume-model" },
          }),
        },
        { id: ids.delta },
      )
    }),
    {
      journal: {
        append: (event) =>
          Effect.sync(() => {
            wire.push(event)
          }),
      },
    },
  )
  return wire
}

async function seedResume(filename: string, events: EventV2.SerializedEvent[]) {
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const service = yield* EventV2.Service
      for (const event of events) yield* service.replay(event)
    }),
  )
}

async function appendExtraLocalEvent(filename: string) {
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* events.publish(
        SessionV1.Event.MessageUpdated,
        {
          sessionID: sessionA,
          info: Schema.decodeUnknownSync(SessionV1.Info)({
            id: extraMessage,
            sessionID: sessionA,
            role: "user",
            time: { created: 4000 },
            agent: "build",
            model: { providerID: "opencode", modelID: "resume-model" },
          }),
        },
        { id: ids.extra },
      )
    }),
  )
}

async function preserveNativeRows(filename: string) {
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`
        INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
        VALUES ('acct_resume', 'resume@example.test', 'https://account.example.test', 'access', 'refresh', 9999, 1, 2)
      `)
      yield* db.run(sql`
        INSERT INTO account_state (id, active_account_id, active_org_id)
        VALUES (1, 'acct_resume', 'org_resume')
      `)
      yield* db.run(sql`
        INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created)
        VALUES ('msg_resume_pending', ${sessionA}, ${JSON.stringify({ text: "preserve" })}, 'queue', 99, 1234)
      `)
    }),
  )
}

async function eraseLocalSession(
  filename: string,
  input: { readonly aggregateID: string; readonly id: EventV2.ID; readonly seq: number },
) {
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .delete(SessionTable)
        .where(sql`${SessionTable.id} = ${input.aggregateID}`)
        .run()
      yield* db
        .delete(EventTable)
        .where(sql`${EventTable.aggregate_id} = ${input.aggregateID}`)
        .run()
      yield* db
        .delete(EventSequenceTable)
        .where(sql`${EventSequenceTable.aggregate_id} = ${input.aggregateID}`)
        .run()
      yield* db
        .insert(CloudHistoryTombstoneTable)
        .values({ aggregate_id: input.aggregateID, event_id: input.id, seq: input.seq })
        .run()
    }),
  )
}

async function inspectInventory(filename: string): Promise<CloudCheckpoint.Inventory> {
  return await withDatabase(
    filename,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const scanned = yield* DatabaseCheckpoint.scan(db)
      return {
        version: 1,
        database: { bytes: 1, sha256: "a".repeat(64), schemaSha256: "b".repeat(64) },
        ...scanned,
      } satisfies CloudCheckpoint.Inventory
    }),
  )
}

async function expectFailure(
  filename: string,
  input: { recovery: ReturnType<typeof createCloudRecovery>; calls: string[] },
) {
  await withDatabase(
    filename,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      expect(Exit.isFailure(yield* events.recover.pipe(Effect.exit))).toBe(true)
      const calls = input.calls.length
      expect(Exit.isFailure(yield* events.recover.pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* events.check.pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(
          yield* events
            .publish(SessionV1.Event.MessageRemoved, { sessionID: sessionA, messageID: baselineMessage })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(input.calls).toHaveLength(calls)
    }),
    input.recovery.eventOptions,
  )
}

async function withDatabase<A, E, R>(filename: string, effect: Effect.Effect<A, E, R>, options?: EventV2.LayerOptions) {
  return await Effect.runPromise(
    effect.pipe(Effect.provide(layers(filename, options) as Layer.Layer<R>), Effect.scoped),
  )
}

function cloudFixture(entries: Entry[], checkpoint: CloudCheckpoint.Checkpoint) {
  const calls: string[] = []
  const reply = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
  const cloud = createCloudHistory({
    checkpointID: checkpoint.id,
    request: async (request) => {
      const route = new URL(request.url).pathname
      calls.push(route)
      if (route === "/v1/epoch") return reply({ epoch: 0 })
      if (route === "/v1/claim") {
        const body = (await request.json()) as { writerID: string }
        return reply({ epoch: 1, writerID: body.writerID })
      }
      if (route === "/v1/read") {
        const body = (await request.json()) as { after: number }
        const remaining = entries.filter((entry) => entry.cursor > body.after)
        const page = remaining.slice(0, 10)
        return reply({ entries: page, cursor: page.at(-1)?.cursor ?? body.after, hasMore: remaining.length > 10 })
      }
      throw new Error("resume recovery must not append")
    },
  })
  return { recovery: createCloudRecovery(cloud, checkpoint, { resume: true }), calls }
}

function pageEntries(events: EventV2.SerializedEvent[]): Entry[] {
  return events.map((event, index) => ({ cursor: index + 1, deleted: false, event }))
}

function sessionInfo(sessionID: Session.ID, projectID: Project.ID, suffix: string) {
  return Schema.decodeUnknownSync(SessionV1.SessionInfo)({
    id: sessionID,
    projectID,
    directory: `/resume/${suffix}`,
    slug: suffix,
    title: `Resume ${suffix}`,
    version: "test",
    time: { created: 2000, updated: 2001 },
  })
}

function archive(seed: string): CloudCheckpoint.Archive {
  return {
    backupID: seed === "1" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
    keyID: `key-${seed}`,
    bytes: 1,
    sha256: seed.repeat(64),
    plaintext: { bytes: 1, sha256: seed.repeat(64) },
  }
}

async function mutate(filename: string, run: (db: InstanceType<(typeof import("bun:sqlite"))["Database"]>) => void) {
  const native = await import("bun:sqlite")
  const db = new native.Database(filename)
  try {
    run(db)
  } finally {
    db.close()
  }
}
