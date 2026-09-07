import { Effect, Schema, Semaphore } from "effect"
import { sql } from "drizzle-orm"
import { isDeepStrictEqual } from "node:util"
import { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { Database } from "../database/database"
import { DatabaseCheckpoint } from "../database/checkpoint"
import { EventV2 } from "../event"
import type { createCloudHistory } from "./cloud-history"
import { eraseCloudSession } from "./cloud-history-erase"
import { EventSequenceTable, EventTable } from "./sql"
import { CloudHistoryTombstoneTable } from "./cloud-history.sql"

export class CloudRecoveryUnavailableError extends Error {
  constructor() {
    super("Cloud түүхийг сэргээж дуусаагүй байна. Түр хүлээгээд дахин оролдоно уу.")
    this.name = "CloudRecoveryUnavailableError"
  }
}

/** One recovery lifetime per native projection, shared by admission and startup. */
export function createCloudRecovery(cloud: ReturnType<typeof createCloudHistory>, input?: CloudCheckpoint.Checkpoint) {
  const baseline = checkpoint(input, cloud.checkpointID)
  const lock = Semaphore.makeUnsafe(1)
  let state: "pending" | "recovering" | "ready" | "failed" = "pending"
  let identity: { events: EventV2.Interface; db: Database.Interface["db"] } | undefined
  const admission = Effect.suspend(() =>
    state === "ready" ? Effect.void : Effect.die(new CloudRecoveryUnavailableError()),
  )
  const recover = lock.withPermit(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      if (identity && (identity.events !== events || identity.db !== db)) {
        state = "failed"
        return yield* Effect.die(new CloudRecoveryUnavailableError())
      }
      if (state === "ready") return
      if (state === "failed") return yield* Effect.die(new CloudRecoveryUnavailableError())
      identity = { events, db }
      state = "recovering"
      yield* Effect.gen(function* () {
        // Never overwrite legacy projections before their explicit export/migration.
        if (baseline) {
          const observed = yield* DatabaseCheckpoint.scan(db).pipe(
            Effect.catchCause(() => Effect.die(new CloudRecoveryUnavailableError())),
          )
          const inventory = baseline.inventory
          // A legacy backup can legitimately gain an empty tombstone table through
          // migration. Every identity, sequence and encoded event hash must match.
          const expected = {
            projects: inventory.projects,
            sessions: inventory.sessions,
            aggregates: inventory.aggregates,
            eventIDs: inventory.eventIDs,
            tombstonesRecorded: observed.tombstonesRecorded,
            tombstones: inventory.tombstones,
            counts: inventory.counts,
          }
          if (!isDeepStrictEqual(observed, expected)) return yield* Effect.die(new CloudRecoveryUnavailableError())
        }
        const legacy =
          !baseline &&
          (yield* db
            .get(
              sql`
          SELECT 1 FROM project p
          WHERE NOT EXISTS (
            SELECT 1 FROM event e
            WHERE e.aggregate_id = p.id AND e.type = 'project.history.changed.1'
          )
          UNION ALL
          SELECT 1 FROM session s
          WHERE NOT EXISTS (
            SELECT 1 FROM event e
            WHERE e.aggregate_id = s.id AND e.type = 'session.created.1'
          )
          LIMIT 1
        `,
            )
            .pipe(Effect.orDie))
        if (legacy)
          return yield* Effect.die(
            new Error(
              "Өмнөх local түүхийг cloud хадгалалт руу шилжүүлээгүй байна. Өгөгдлийг хамгаалж сэргээхийг зогсоолоо.",
            ),
          )
        yield* cloud.initialize
        // Replay owners belong to the old local projection, not the cloud writer
        // lease. Drop them only on a validated baseline after obtaining that lease.
        if (baseline) yield* db.update(EventSequenceTable).set({ owner_id: null }).run().pipe(Effect.orDie)
        // Global cursor order preserves project/session dependencies across aggregates.
        let cursor = 0
        const expectedEvents = new Map((baseline?.inventory.eventIDs ?? []).map((row) => [row.id, row]))
        const expectedTombstones = new Map((baseline?.inventory.tombstones ?? []).map((row) => [row.aggregateID, row]))
        const seen = new Set([...expectedEvents.keys(), ...Array.from(expectedTombstones.values(), (row) => row.id)])
        while (true) {
          const page = yield* cloud.read(cursor)
          for (const entry of page.entries) {
            const id = entry.deleted ? entry.id : entry.event.id
            if (seen.has(id)) return yield* Effect.die(new CloudRecoveryUnavailableError())
            seen.add(id)
            if (entry.deleted) {
              yield* eraseCloudSession(db, entry)
              for (const [id, row] of expectedEvents)
                if (row.aggregateID === entry.aggregateID) expectedEvents.delete(id)
              expectedTombstones.set(entry.aggregateID, {
                aggregateID: entry.aggregateID,
                id: entry.id,
                seq: entry.seq,
              })
            } else {
              yield* events.replay(entry.event)
              expectedEvents.set(entry.event.id, {
                id: entry.event.id,
                aggregateID: entry.event.aggregateID,
                seq: entry.event.seq,
              })
            }
          }
          cursor = page.cursor
          if (!page.hasMore) break
        }
        // Replay checks exact identities/content. Extra local rows are not proof of a remote receipt.
        const stored = yield* db
          .select({ id: EventTable.id, aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
          .from(EventTable)
          .all()
          .pipe(Effect.orDie)
        const tombstones = yield* db.select().from(CloudHistoryTombstoneTable).all().pipe(Effect.orDie)
        if (
          stored.length !== expectedEvents.size ||
          tombstones.length !== expectedTombstones.size ||
          stored.some((row) => {
            const expected = expectedEvents.get(row.id)
            return expected?.aggregateID !== row.aggregateID || expected.seq !== row.seq
          }) ||
          tombstones.some((row) => {
            const expected = expectedTombstones.get(row.aggregate_id)
            return expected?.id !== row.event_id || expected.seq !== row.seq
          })
        )
          return yield* Effect.die(
            new Error("Cloud-д баталгаажаагүй local түүх байна. Өгөгдөл шилжүүлэх шаардлагатай."),
          )
        state = "ready"
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Failure") state = "failed"
          }),
        ),
      )
    }),
  )
  return { admission, recover, eventOptions: { admission, recovery: recover, journal: cloud, requireProjectors: true } }
}

function checkpoint(input: CloudCheckpoint.Checkpoint | undefined, id: string | undefined) {
  if (input === undefined && id === undefined) return undefined
  try {
    const json = JSON.stringify(input)
    if (!json || Buffer.byteLength(json) > 1024 * 1024) throw new Error()
    const value = Schema.decodeUnknownSync(CloudCheckpoint.Checkpoint)(
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(json),
      { onExcessProperty: "error" },
    )
    if (value.id !== id) throw new Error()
    return value
  } catch {
    throw new CloudRecoveryUnavailableError()
  }
}
