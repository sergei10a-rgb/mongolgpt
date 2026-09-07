import { Effect, Semaphore } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import type { createCloudHistory } from "./cloud-history"
import { eraseCloudSession } from "./cloud-history-erase"

export class CloudRecoveryUnavailableError extends Error {
  constructor() {
    super("Cloud түүхийг сэргээж дуусаагүй байна. Түр хүлээгээд дахин оролдоно уу.")
    this.name = "CloudRecoveryUnavailableError"
  }
}

/** One recovery lifetime per native projection, shared by admission and startup. */
export function createCloudRecovery(cloud: ReturnType<typeof createCloudHistory>) {
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
        const legacy = yield* db
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
          .pipe(Effect.orDie)
        if (legacy)
          return yield* Effect.die(
            new Error(
              "Өмнөх local түүхийг cloud хадгалалт руу шилжүүлээгүй байна. Өгөгдлийг хамгаалж сэргээхийг зогсоолоо.",
            ),
          )
        yield* cloud.initialize
        // Global cursor order preserves project/session dependencies across aggregates.
        let cursor = 0
        while (true) {
          const page = yield* cloud.read(cursor)
          for (const entry of page.entries) {
            if (entry.deleted) yield* eraseCloudSession(db, entry)
            else yield* events.replay(entry.event)
          }
          cursor = page.cursor
          if (!page.hasMore) break
        }
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
  return { admission, recover, eventOptions: { admission, journal: cloud, requireProjectors: true } }
}
