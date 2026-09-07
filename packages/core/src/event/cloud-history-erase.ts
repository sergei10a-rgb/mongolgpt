import { Effect, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { Event } from "@mongolgpt/schema/event"
import { Project } from "@mongolgpt/schema/project"
import type { EventV2 } from "../event"
import type { Database } from "../database/database"
import { EventSequenceTable, EventTable } from "./sql"
import { CloudHistoryTombstoneTable } from "./cloud-history.sql"
import { ProjectTable } from "../project/sql"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"

const deletedType = "session.deleted.1"
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/))
const EventID = Event.ID.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/))
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export const eraseCloudSession = Effect.fn("CloudHistory.eraseCloudSession")(function* (
  db: Database.Interface["db"],
  input: { readonly aggregateID: string; readonly id: EventV2.ID; readonly seq: number },
) {
  const aggregateID = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Identifier)(input.aggregateID),
    catch: () => new CloudHistoryEraseError("invalid_input"),
  }).pipe(Effect.orDie)
  const id = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(EventID)(input.id),
    catch: () => new CloudHistoryEraseError("invalid_input"),
  }).pipe(Effect.orDie)
  const seq = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Sequence)(input.seq),
    catch: () => new CloudHistoryEraseError("invalid_input"),
  }).pipe(Effect.orDie)

  yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const marker = yield* db
            .select()
            .from(CloudHistoryTombstoneTable)
            .where(eq(CloudHistoryTombstoneTable.aggregate_id, aggregateID))
            .get()
            .pipe(Effect.orDie)
          if (marker) {
            if (marker.event_id === id && marker.seq === seq) return
            return yield* Effect.die(new CloudHistoryEraseError("conflict"))
          }

          if (
            yield* db
              .select({ id: ProjectTable.id })
              .from(ProjectTable)
              .where(eq(ProjectTable.id, Project.ID.make(aggregateID)))
              .get()
              .pipe(Effect.orDie)
          ) {
            return yield* Effect.die(new CloudHistoryEraseError("conflict"))
          }

          const sequence = yield* db
            .select({ seq: EventSequenceTable.seq })
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
            .get()
            .pipe(Effect.orDie)
          if (sequence && seq < sequence.seq) return yield* Effect.die(new CloudHistoryEraseError("conflict"))

          const storedEvent = yield* db
            .select({
              id: EventTable.id,
              aggregateID: EventTable.aggregate_id,
              seq: EventTable.seq,
              type: EventTable.type,
            })
            .from(EventTable)
            .where(eq(EventTable.id, id))
            .get()
            .pipe(Effect.orDie)
          if (
            storedEvent &&
            (storedEvent.aggregateID !== aggregateID || storedEvent.seq !== seq || storedEvent.type !== deletedType)
          ) {
            return yield* Effect.die(new CloudHistoryEraseError("conflict"))
          }
          if (sequence?.seq === seq) {
            const head = yield* db
              .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type })
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, seq)))
              .get()
              .pipe(Effect.orDie)
            if (head?.id !== id || head.type !== deletedType)
              return yield* Effect.die(new CloudHistoryEraseError("conflict"))
          }

          yield* db
            .delete(SessionTable)
            .where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID)))
            .run()
            .pipe(Effect.orDie)
          yield* db
            .delete(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
            .run()
            .pipe(Effect.orDie)
          yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run().pipe(Effect.orDie)
          yield* db
            .insert(CloudHistoryTombstoneTable)
            .values({ aggregate_id: aggregateID, event_id: id, seq })
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

class CloudHistoryEraseError extends Error {
  constructor(readonly code: "invalid_input" | "conflict") {
    super(
      code === "invalid_input" ? "Cloud түүхийн устгалын өгөгдөл буруу байна." : "Cloud түүхийн устгал зөрсөн байна.",
    )
    this.name = "CloudHistoryEraseError"
  }
}
