export { Effect } from "effect"
import { Effect, Layer } from "effect"
import { Database } from "../../../core/src/database/database"
import { EventV2 } from "../../../core/src/event"
import { createCloudRecovery } from "../../../core/src/event/cloud-recovery"
import { CloudHistoryTombstoneTable } from "../../../core/src/event/cloud-history.sql"
import { ProjectHistory } from "../../../core/src/project/history"
import { ProjectDirectoryTable, ProjectTable } from "../../../core/src/project/sql"
import { SessionProjector } from "../../../core/src/session/projector"
import { SessionTable } from "../../../core/src/session/sql"
export { createCloudHistory } from "../../../core/src/event/cloud-history"
export { createHistoryHandler, handleHistoryOutbound } from "../../src/history-rpc"

import { createCloudHistory } from "../../../core/src/event/cloud-history"

export async function recoverProjection(request: (request: Request) => Promise<Response>, filename: string) {
  const recovery = createCloudRecovery(createCloudHistory({ request }))
  const database = Database.layerFromPath(filename)
  const events = EventV2.layerWith(recovery.eventOptions)
  const layer = Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
    Layer.provideMerge(events),
    Layer.provideMerge(database),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* recovery.recover
      const { db } = yield* Database.Service
      const projects = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)
      const directories = yield* db.select().from(ProjectDirectoryTable).all().pipe(Effect.orDie)
      const sessions = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
      const tombstones = yield* db.select().from(CloudHistoryTombstoneTable).all().pipe(Effect.orDie)
      return {
        projects: projects.sort((a, b) => a.id.localeCompare(b.id)),
        directories: directories.sort(
          (a, b) => a.project_id.localeCompare(b.project_id) || a.directory.localeCompare(b.directory),
        ),
        sessions: sessions.sort((a, b) => a.id.localeCompare(b.id)),
        tombstones: tombstones.sort((a, b) => a.aggregate_id.localeCompare(b.aggregate_id)),
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}
