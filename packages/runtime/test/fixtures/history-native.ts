export { Effect } from "effect"
import assert from "node:assert/strict"
import { Effect, Exit, Layer, Schema } from "effect"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { SessionID } from "@mongolgpt/schema/session-id"
import { Project } from "@mongolgpt/schema/project"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { CloudRestore } from "../../../core/src/database/cloud-restore"
import { Database } from "../../../core/src/database/database"
import { EventV2 } from "../../../core/src/event"
import { createCloudRecovery } from "../../../core/src/event/cloud-recovery"
import { CloudHistoryTombstoneTable } from "../../../core/src/event/cloud-history.sql"
import { ProjectHistory } from "../../../core/src/project/history"
import { ProjectDirectoryTable, ProjectTable } from "../../../core/src/project/sql"
import { SessionProjector } from "../../../core/src/session/projector"
import { MessageTable, PartTable, SessionTable } from "../../../core/src/session/sql"
import { EventTable } from "../../../core/src/event/sql"
import { AbsolutePath } from "../../../core/src/schema"
export { createCloudHistory } from "../../../core/src/event/cloud-history"
export { createHistoryHandler, handleHistoryOutbound } from "../../src/history-rpc"
export { handleCheckpointOutbound, createCheckpointHandler } from "../../src/checkpoint-rpc"
export { CloudStartup } from "../../../core/src/database/cloud-startup"
export { CloudBaseline } from "../../../core/src/database/cloud-baseline"
export { WorkspaceCapture } from "../../../core/src/database/workspace-capture"
export { CloudFiles } from "../../../core/src/database/cloud-files"
export { createHistoryStore } from "../../src/history"
export { createRuntimeCheckpointStore } from "../../src/checkpoint"
export { createRuntimeBackupStore, deriveRuntimeBackupKey } from "../../src/backup"
export { createCheckpointFixture } from "./checkpoint-native"

import { createCloudHistory } from "../../../core/src/event/cloud-history"
import { RuntimeCheckpointClient } from "../../../core/src/runtime-checkpoint-client"
import { deriveCheckpointControlToken } from "../../../runtime-auth/src/control"

export async function createRuntimeCheckpointClient(input: {
  secret: string
  scope: { accountID: string; workspaceID: string }
  request: (request: Request) => Promise<Response>
}) {
  return RuntimeCheckpointClient.create(await deriveCheckpointControlToken(input.secret, input.scope), input.request)
}

export async function postcommitProjection(input: {
  filename: string
  checkpoint: CloudCheckpoint.Checkpoint
  cloud: Parameters<typeof createCloudHistory>[0]
  notify: () => void
  resume?: boolean
}) {
  const recovery = createCloudRecovery(createCloudHistory(input.cloud), input.checkpoint, { resume: input.resume })
  const layer = Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
    Layer.provideMerge(EventV2.layerWith(recovery.eventOptions)),
    Layer.provideMerge(Database.layerFromPath(input.filename)),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.recover
      yield* events.listen(() => Effect.sync(input.notify))
      const publish = Effect.gen(function* () {
        const projectID = Project.ID.make("proj_postcommit")
        yield* db.run("CREATE TABLE native_postcommit (value TEXT NOT NULL)").pipe(Effect.orDie)
        yield* events.publish(
          ProjectHistory.Changed,
          {
            projectID,
            change: {
              type: "saved",
              info: {
                id: projectID,
                worktree: AbsolutePath.make("/workspace"),
                name: "Postcommit integration",
                time: { created: 1710000000000, updated: 1710000000000 },
                sandboxes: [],
              },
            },
          },
          {
            id: EventV2.ID.make("evt_postcommit"),
            commit: () =>
              db
                .run("INSERT INTO native_postcommit VALUES ('private committed state')")
                .pipe(Effect.asVoid, Effect.orDie),
          },
        )
      })
      const result = yield* (input.resume ? Effect.void : publish).pipe(Effect.exit)
      return {
        accepted: Exit.isSuccess(result),
        admitted: Exit.isSuccess(yield* events.check.pipe(Effect.exit)),
        rows: yield* db.all<{ value: string }>("SELECT value FROM native_postcommit").pipe(Effect.orDie),
        events: yield* db.select().from(EventTable).all().pipe(Effect.orDie),
        projects: yield* db.select().from(ProjectTable).all().pipe(Effect.orDie),
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

export function restoreCheckpoint(input: Parameters<typeof CloudRestore.restore>[0]) {
  return Effect.runPromise(CloudRestore.restore(input))
}

export async function recoverCheckpoint(
  restored: CloudRestore.Restored,
  request: (request: Request) => Promise<Response>,
  action?: "update" | "delete" | "tamper-after-open",
) {
  const runtime = CloudRestore.createRuntime(restored, request)
  assert.equal(Exit.isFailure(await Effect.runPromiseExit(runtime.admission)), true)
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      if (action === "tamper-after-open")
        yield* database.db.run(
          "UPDATE event SET data = json_set(data, '$.part.text', 'Edited outside journal') WHERE id = 'evt_checkpoint_part'",
        )
      yield* events.recover
      yield* runtime.admission
      const previousParts = yield* database.db.select().from(PartTable).all().pipe(Effect.orDie)
      if (action === "update") {
        yield* events.publish(
          SessionV1.Event.PartUpdated,
          {
            sessionID: SessionID.make("ses_checkpoint"),
            time: 1710000004000,
            part: Schema.decodeUnknownSync(SessionV1.Part)({
              id: "prt_checkpoint",
              sessionID: "ses_checkpoint",
              messageID: "msg_checkpoint",
              type: "text",
              text: "New chat after checkpoint",
            }),
          },
          { id: EventV2.ID.make("evt_checkpoint_update") },
        )
      }
      if (action === "delete") {
        const session = yield* database.db.select().from(SessionTable).get().pipe(Effect.orDie)
        assert.ok(session)
        yield* events.publish(
          SessionV1.Event.Deleted,
          {
            sessionID: SessionID.make(session.id),
            info: Schema.decodeUnknownSync(SessionV1.SessionInfo)({
              id: session.id,
              slug: session.slug,
              projectID: session.project_id,
              directory: session.directory,
              title: session.title,
              version: session.version,
              time: { created: session.time_created, updated: session.time_updated },
            }),
          },
          { id: EventV2.ID.make("evt_checkpoint_erase") },
        )
      }
      return {
        previousParts,
        projects: yield* database.db.select().from(ProjectTable).all().pipe(Effect.orDie),
        sessions: yield* database.db.select().from(SessionTable).all().pipe(Effect.orDie),
        messages: yield* database.db.select().from(MessageTable).all().pipe(Effect.orDie),
        parts: yield* database.db.select().from(PartTable).all().pipe(Effect.orDie),
        events: yield* database.db.select().from(EventTable).all().pipe(Effect.orDie),
        tombstones: yield* database.db.select().from(CloudHistoryTombstoneTable).all().pipe(Effect.orDie),
      }
    }).pipe(Effect.provide(runtime.layer), Effect.scoped),
  )
}

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
      const events = yield* EventV2.Service
      yield* events.recover
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
