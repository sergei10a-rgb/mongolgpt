export * as DatabaseCheckpoint from "./checkpoint"

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@mongolgpt/effect-drizzle-sqlite"
import { Durable } from "@mongolgpt/schema/durable-event-manifest"
import { ProjectHistory } from "@mongolgpt/schema/project-history"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { DatabaseBackup } from "./backup"
import type { Database } from "./database"

export class CheckpointError extends Schema.TaggedErrorClass<CheckpointError>()("DatabaseCheckpointError", {
  message: Schema.String,
}) {}

export type Inventory = CloudCheckpoint.Inventory

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/))
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(Number.MAX_SAFE_INTEGER))
const EventRow = Schema.Struct({
  id: Identifier,
  aggregate_id: Identifier,
  seq: Sequence,
  type: Identifier,
  data: Schema.String,
})
const pageSize = 128
const maxEventBytes = 1024 * 1024

/** Metadata for a future native bootstrap, never a synthetic event replay.
 * The caller owns a private immutable restore and its authenticated receipt.
 * No AppRuntime, migration, projector, writer claim or credential service is started.
 */
export function inspect(input: { source: string; expected: DatabaseBackup.Report }) {
  return Effect.gen(function* () {
    const source = resolve(input.source)
    const receipt = yield* DatabaseBackup.verify({ source, expected: input.expected })
    const sqlite = yield* Effect.promise(() => import("#sqlite"))
    const inventory = yield* read().pipe(
      Effect.provide(
        sqlite.layer({ filename: source, readonly: true, readwrite: false, create: false, disableWAL: true }),
      ),
      Effect.scoped,
    )
    // The content inspected must still be the same authenticated SQLite image.
    yield* DatabaseBackup.verify({ source, expected: receipt })
    return {
      version: 1,
      database: { bytes: receipt.bytes, sha256: receipt.sha256, schemaSha256: receipt.schemaSha256 },
      ...inventory,
    } satisfies Inventory
  }).pipe(
    Effect.catchCause(() =>
      Effect.fail(
        new CheckpointError({
          message: "Сэргээсэн түүхийн эх төлөвийг баталгаажуулж чадсангүй. Өгөгдлийг өөрчлөөгүй.",
        }),
      ),
    ),
  )
}

function read() {
  return Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run("PRAGMA trusted_schema = OFF")
    yield* db.run("PRAGMA query_only = ON")
    return yield* scan(db)
  })
}

/** Revalidate inventory on the actual migrated projection while admission is closed.
 * Unlike inspect(), this does not authenticate a file receipt or change connection pragmas.
 */
export function scan(db: Database.Interface["db"]) {
  return db.transaction(() =>
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string; type: string }>(sql`
          SELECT name, type FROM sqlite_schema
          WHERE name IN ('project', 'session', 'event', 'event_sequence', 'cloud_history_tombstone')
        `)
      if (
        tables.some((row) => row.type !== "table") ||
        ["project", "session", "event", "event_sequence"].some((name) => !tables.some((row) => row.name === name))
      )
        throw invalid()
      const tombstonesRecorded = tables.some((row) => row.name === "cloud_history_tombstone")
      const projects = yield* db.all<{ id: string }>(sql`SELECT id FROM project ORDER BY id`)
      const sessions = yield* db.all<{ id: string; project_id: string }>(
        sql`SELECT id, project_id FROM session ORDER BY id`,
      )
      const heads = yield* db.all<{ aggregate_id: string; seq: number }>(
        sql`SELECT aggregate_id, seq FROM event_sequence ORDER BY aggregate_id`,
      )
      // Old runtimes predate this table. Record its absence; never run migrations
      // or mistake an unrecorded legacy deletion history for verified tombstones.
      const tombstones = tombstonesRecorded
        ? yield* db.all<{ aggregate_id: string; event_id: string; seq: number }>(
            sql`SELECT aggregate_id, event_id, seq FROM cloud_history_tombstone ORDER BY aggregate_id`,
          )
        : []
      if (
        yield* db.get(sql`
          SELECT 1 FROM event WHERE typeof(data) != 'text'
            OR length(CAST(data AS BLOB)) > ${maxEventBytes} LIMIT 1
        `)
      )
        throw invalid()
      const projectIDs = new Set(projects.map((row) => Schema.decodeUnknownSync(Identifier)(row.id)))
      const sessionIDs = new Set(sessions.map((row) => Schema.decodeUnknownSync(Identifier)(row.id)))
      if (projectIDs.size !== projects.length || sessionIDs.size !== sessions.length) throw invalid()
      for (const row of sessions) {
        if (!projectIDs.has(row.project_id) || projectIDs.has(row.id)) throw invalid()
      }
      const sequences = new Map<string, number>()
      for (const head of heads) {
        Schema.decodeUnknownSync(Identifier)(head.aggregate_id)
        Schema.decodeUnknownSync(Sequence)(head.seq)
        if (sequences.has(head.aggregate_id)) throw invalid()
        if (!projectIDs.has(head.aggregate_id) && !sessionIDs.has(head.aggregate_id)) throw invalid()
        sequences.set(head.aggregate_id, head.seq)
      }
      const erasedIDs = new Set<string>()
      const erasedEventIDs = new Set<string>()
      for (const marker of tombstones) {
        Schema.decodeUnknownSync(Identifier)(marker.aggregate_id)
        Schema.decodeUnknownSync(Identifier)(marker.event_id)
        Schema.decodeUnknownSync(Sequence)(marker.seq)
        if (
          erasedIDs.has(marker.aggregate_id) ||
          erasedEventIDs.has(marker.event_id) ||
          projectIDs.has(marker.aggregate_id) ||
          sessionIDs.has(marker.aggregate_id) ||
          sequences.has(marker.aggregate_id)
        )
          throw invalid()
        erasedIDs.add(marker.aggregate_id)
        erasedEventIDs.add(marker.event_id)
      }
      const aggregates: Array<Inventory["aggregates"][number]> = []
      const journaled = new Set<string>()
      const seenEventIDs = new Set<string>()
      const eventIDs: Array<Inventory["eventIDs"][number]> = []
      let current: { id: string; seq: number; events: number; hash: ReturnType<typeof createHash> } | undefined
      let afterAggregate = ""
      let afterSequence = -1
      let events = 0

      function finish() {
        if (!current) return
        if (sequences.get(current.id) !== current.seq) throw invalid()
        aggregates.push({
          id: current.id,
          seq: current.seq,
          events: current.events,
          sha256: current.hash.digest("hex"),
        })
      }

      // Only per-aggregate order exists in legacy SQLite. Never invent a global cursor.
      while (true) {
        const page = yield* db.all<typeof EventRow.Type>(sql`
            SELECT id, aggregate_id, seq, type, data FROM event
            WHERE aggregate_id > ${afterAggregate} OR (aggregate_id = ${afterAggregate} AND seq > ${afterSequence})
            ORDER BY aggregate_id, seq LIMIT ${pageSize}
          `)
        for (const value of page) {
          const row = Schema.decodeUnknownSync(EventRow)(value)
          if (Buffer.byteLength(row.data) > maxEventBytes || seenEventIDs.has(row.id) || erasedEventIDs.has(row.id))
            throw invalid()
          seenEventIDs.add(row.id)
          eventIDs.push({ id: row.id, aggregateID: row.aggregate_id, seq: row.seq })
          const definition = Durable.get(row.type)
          if (!definition?.durable || !sequences.has(row.aggregate_id) || erasedIDs.has(row.aggregate_id))
            throw invalid()
          const decoded = Schema.decodeUnknownSync(definition.data)(
            Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(row.data),
            { onExcessProperty: "error" },
          ) as Record<string, unknown>
          if (decoded[definition.durable.aggregate] !== row.aggregate_id) throw invalid()
          if (definition === ProjectHistory.Changed) {
            if (!projectIDs.has(row.aggregate_id)) throw invalid()
            const value = Schema.decodeUnknownSync(ProjectHistory.Changed.data)(decoded)
            if (value.change.type === "saved" && value.change.info.id !== value.projectID) throw invalid()
            journaled.add(row.aggregate_id)
          } else {
            if (!sessionIDs.has(row.aggregate_id) || definition === SessionV1.Event.Deleted) throw invalid()
            if (definition === SessionV1.Event.Created) {
              const value = Schema.decodeUnknownSync(SessionV1.Event.Created.data)(decoded)
              if (value.info.id !== row.aggregate_id || !projectIDs.has(value.info.projectID)) throw invalid()
              journaled.add(row.aggregate_id)
            }
          }
          if (current?.id !== row.aggregate_id) {
            finish()
            current = { id: row.aggregate_id, seq: -1, events: 0, hash: createHash("sha256") }
          }
          if (row.seq !== current.seq + 1) throw invalid()
          current.seq = row.seq
          current.events++
          // Unambiguous framing includes the original encoded payload without exposing it.
          current.hash.update(JSON.stringify([row.id, row.aggregate_id, row.seq, row.type, row.data]) + "\n")
          afterAggregate = row.aggregate_id
          afterSequence = row.seq
          events++
        }
        if (page.length < pageSize) break
      }
      finish()
      if (aggregates.length !== sequences.size) throw invalid()
      const stored = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM event`)
      if (stored?.count !== events) throw invalid()
      return {
        projects: projects.map((row) => ({ id: row.id, journaled: journaled.has(row.id) })),
        sessions: sessions.map((row) => ({
          id: row.id,
          projectID: row.project_id,
          journaled: journaled.has(row.id),
        })),
        aggregates,
        eventIDs,
        tombstonesRecorded,
        tombstones: tombstones.map((row) => ({ aggregateID: row.aggregate_id, id: row.event_id, seq: row.seq })),
        counts: { events, tombstones: tombstones.length },
      }
    }),
  )
}

/** Validate only the immutable checkpoint prefix in the current native database.
 * Resume may have later durable rows and unrelated native state, so this helper
 * authenticates the original aggregate heads without treating the whole DB as a
 * pristine checkpoint image.
 */
export function verifyPrefix(
  db: Database.Interface["db"],
  input: {
    readonly inventory: Inventory
    readonly deletedAggregates?: ReadonlySet<string>
  },
) {
  return db.transaction(() =>
    Effect.gen(function* () {
      const deletedAggregates = input.deletedAggregates ?? new Set<string>()
      const tables = yield* db.all<{ name: string; type: string }>(sql`
          SELECT name, type FROM sqlite_schema
          WHERE name IN ('project', 'session', 'event', 'event_sequence', 'cloud_history_tombstone')
        `)
      if (
        tables.some((row) => row.type !== "table") ||
        ["project", "session", "event", "event_sequence"].some((name) => !tables.some((row) => row.name === name))
      )
        throw invalid()

      const projectIDs = new Set((yield* db.all<{ id: string }>(sql`SELECT id FROM project`)).map((row) => row.id))
      const sessions = new Map(
        (yield* db.all<{ id: string; project_id: string }>(sql`SELECT id, project_id FROM session`)).map((row) => [
          row.id,
          row.project_id,
        ]),
      )
      for (const row of input.inventory.projects) {
        Schema.decodeUnknownSync(Identifier)(row.id)
        if (!deletedAggregates.has(row.id) && !projectIDs.has(row.id)) throw invalid()
      }
      for (const row of input.inventory.sessions) {
        Schema.decodeUnknownSync(Identifier)(row.id)
        Schema.decodeUnknownSync(Identifier)(row.projectID)
        if (!deletedAggregates.has(row.id) && sessions.get(row.id) !== row.projectID) throw invalid()
      }

      const expectedByAggregate = new Map<string, Map<number, string>>()
      const seenEventIDs = new Set<string>()
      for (const event of input.inventory.eventIDs) {
        Schema.decodeUnknownSync(Identifier)(event.id)
        Schema.decodeUnknownSync(Identifier)(event.aggregateID)
        Schema.decodeUnknownSync(Sequence)(event.seq)
        if (seenEventIDs.has(event.id)) throw invalid()
        seenEventIDs.add(event.id)
        const events = expectedByAggregate.get(event.aggregateID) ?? new Map<number, string>()
        if (events.has(event.seq)) throw invalid()
        events.set(event.seq, event.id)
        expectedByAggregate.set(event.aggregateID, events)
      }

      let accountedEvents = 0
      for (const aggregate of input.inventory.aggregates) {
        Schema.decodeUnknownSync(Identifier)(aggregate.id)
        Schema.decodeUnknownSync(Sequence)(aggregate.seq)
        Schema.decodeUnknownSync(Sequence)(aggregate.events)
        const expected = expectedByAggregate.get(aggregate.id)
        if (!expected || expected.size !== aggregate.events) throw invalid()
        for (let seq = 0; seq <= aggregate.seq; seq++) {
          if (!expected.has(seq)) throw invalid()
        }

        const sequence = yield* db.get<{ seq: number }>(sql`
            SELECT seq FROM event_sequence WHERE aggregate_id = ${aggregate.id}
          `)
        if (!sequence) {
          if (deletedAggregates.has(aggregate.id)) {
            accountedEvents += aggregate.events
            continue
          }
          throw invalid()
        }
        Schema.decodeUnknownSync(Sequence)(sequence.seq)
        if (sequence.seq < aggregate.seq) throw invalid()

        let afterSequence = -1
        let count = 0
        const hash = createHash("sha256")
        while (true) {
          const page = yield* db.all<typeof EventRow.Type>(sql`
              SELECT id, aggregate_id, seq, type, data FROM event
              WHERE aggregate_id = ${aggregate.id}
                AND seq > ${afterSequence}
                AND seq <= ${aggregate.seq}
              ORDER BY seq LIMIT ${pageSize}
            `)
          for (const value of page) {
            const row = Schema.decodeUnknownSync(EventRow)(value)
            if (Buffer.byteLength(row.data) > maxEventBytes) throw invalid()
            if (row.seq !== afterSequence + 1 || row.aggregate_id !== aggregate.id) throw invalid()
            if (expected.get(row.seq) !== row.id) throw invalid()
            hash.update(frame(row))
            afterSequence = row.seq
            count++
          }
          if (page.length < pageSize) break
        }
        if (count !== aggregate.events || afterSequence !== aggregate.seq || hash.digest("hex") !== aggregate.sha256)
          throw invalid()
        accountedEvents += count
      }
      if (accountedEvents !== input.inventory.counts.events) throw invalid()
    }),
  )
}

function frame(row: typeof EventRow.Type) {
  return JSON.stringify([row.id, row.aggregate_id, row.seq, row.type, row.data]) + "\n"
}

function invalid() {
  return new Error("Invalid restored history inventory")
}
