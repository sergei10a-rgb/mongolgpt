export { Effect } from "effect"

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Layer, Schema } from "effect"
import { Project } from "@mongolgpt/schema/project"
import { SessionID } from "@mongolgpt/schema/session-id"
import { SessionV1 } from "@mongolgpt/schema/session-v1"
import { WorkspaceID } from "@mongolgpt/schema/workspace-id"
import { DatabaseBackup } from "../../../core/src/database/backup"
import { DatabaseCheckpoint } from "../../../core/src/database/checkpoint"
import { Database } from "../../../core/src/database/database"
import { EventV2 } from "../../../core/src/event"
import { CloudHistoryTombstoneTable } from "../../../core/src/event/cloud-history.sql"
import { ProjectHistory } from "../../../core/src/project/history"
import { ProjectTable } from "../../../core/src/project/sql"
import { AbsolutePath } from "../../../core/src/schema"
import { SessionProjector } from "../../../core/src/session/projector"
import { deriveRuntimeBackupKey } from "../../src/backup"
import type { HistoryScope } from "../../src/history"

const defaultScope = { accountID: "acc_checkpoint", workspaceID: "wrk_checkpoint" } satisfies HistoryScope
const keyID = "key_checkpoint_synthetic"
const master = Buffer.from("9b4f5d452df4b2a252956e2a31a8245f5f6453c8849974c1f94e72cd8b5b9466", "hex")

export interface CheckpointArchiveSeed {
  keyID: string
  plaintext: { bytes: number; sha256: string }
}

export interface CheckpointFixtureInput {
  id: string
  inventory: DatabaseCheckpoint.Inventory
  sqlite: CheckpointArchiveSeed
  files: CheckpointArchiveSeed
}

export interface CheckpointFixture {
  input: CheckpointFixtureInput
  sqliteArchive: string
  filesArchive: string
  master: Uint8Array
}

export async function createCheckpointFixture(
  root: string,
  scope: HistoryScope = defaultScope,
): Promise<CheckpointFixture> {
  const token = `${scope.accountID}-${scope.workspaceID}-${crypto.randomUUID()}`
  const source = join(root, `${token}-native.sqlite`)
  const sqliteArchive = join(root, `${token}-native.backup`)
  const restored = join(root, `${token}-restored.sqlite`)
  const filesSource = join(root, `${token}-files.sqlite`)
  const filesArchive = join(root, `${token}-files.backup`)
  const key = deriveRuntimeBackupKey(scope, keyID, master)

  const expectedEventIDs = await seedNative(source)
  const sqliteReport = await Effect.runPromise(
    DatabaseBackup.create({ source, destination: sqliteArchive, key: Buffer.from(key) }),
  )
  await Effect.runPromise(
    DatabaseBackup.restore({ source: sqliteArchive, destination: restored, key: Buffer.from(key) }),
  )
  const inspected = await Effect.runPromise(DatabaseCheckpoint.inspect({ source: restored, expected: sqliteReport }))
  assert.deepEqual(inspected.eventIDs, expectedEventIDs)

  seedFiles(filesSource)
  const filesReport = await Effect.runPromise(
    DatabaseBackup.create({ source: filesSource, destination: filesArchive, key: Buffer.from(key) }),
  )
  return {
    input: {
      id: "11111111-1111-4111-8111-111111111111",
      inventory: inspected,
      sqlite: { keyID, plaintext: { bytes: sqliteReport.bytes, sha256: sqliteReport.sha256 } },
      files: { keyID, plaintext: { bytes: filesReport.bytes, sha256: filesReport.sha256 } },
    },
    sqliteArchive,
    filesArchive,
    master: new Uint8Array(master),
  }
}

async function seedNative(filename: string) {
  const projectID = "checkpoint_project"
  const sessionID = "ses_checkpoint"
  const project = Project.ID.make(projectID)
  const session = SessionID.make(sessionID)
  const projectEvent = EventV2.ID.make("evt_checkpoint_project")
  const sessionEvent = EventV2.ID.make("evt_checkpoint_session")
  const deletedEvent = EventV2.ID.make("evt_checkpoint_deleted")
  const emptySandboxes: AbsolutePath[] = []
  const layer = Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
    Layer.provideMerge(EventV2.layerWith()),
    Layer.provideMerge(Database.layerFromPath(filename)),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* events.publish(
        ProjectHistory.Changed,
        {
          projectID: project,
          change: {
            type: "saved",
            info: {
              id: project,
              worktree: "/workspace/checkpoint",
              vcs: "git",
              name: "Checkpoint Project",
              icon: { color: "blue" },
              commands: { start: "bun dev" },
              time: { created: 1710000000000, updated: 1710000001000, initialized: 1710000000500 },
              sandboxes: ["/workspace/checkpoint-copy"],
            },
            directories: [
              {
                directory: "/workspace/checkpoint",
                type: "git_worktree",
                strategy: "git-worktree",
                time: 1710000000000,
              },
            ],
          },
        },
        { id: projectEvent },
      )
      yield* events.publish(
        SessionV1.Event.Created,
        {
          sessionID: session,
          info: {
            id: session,
            slug: "checkpoint",
            projectID: project,
            workspaceID: WorkspaceID.ascending("wrk_native_checkpoint"),
            directory: "/workspace/checkpoint",
            title: "Checkpoint Session",
            version: "test",
            metadata: { fixture: "checkpoint" },
            time: { created: 1710000002000, updated: 1710000003000 },
          },
        },
        { id: sessionEvent },
      )
      yield* events.publish(
        SessionV1.Event.MessageUpdated,
        {
          sessionID: session,
          info: Schema.decodeUnknownSync(SessionV1.Info)({
            id: "msg_checkpoint",
            sessionID: session,
            role: "user",
            time: { created: 1710000003001 },
            agent: "build",
            model: { providerID: "opencode", modelID: "big-pickle" },
          }),
        },
        { id: EventV2.ID.make("evt_checkpoint_message") },
      )
      yield* events.publish(
        SessionV1.Event.PartUpdated,
        {
          sessionID: session,
          time: 1710000003002,
          part: Schema.decodeUnknownSync(SessionV1.Part)({
            id: "prt_checkpoint",
            sessionID: session,
            messageID: "msg_checkpoint",
            type: "text",
            text: "Restored chat content",
          }),
        },
        { id: EventV2.ID.make("evt_checkpoint_part") },
      )
      yield* events.claim(session, "old_instance_replay_owner")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: Project.ID.make("checkpoint_legacy"),
          worktree: AbsolutePath.make("/workspace/legacy"),
          vcs: "git",
          name: "Legacy Project",
          icon_color: "gray",
          time_created: 1700000000000,
          time_updated: 1700000001000,
          sandboxes: emptySandboxes,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(CloudHistoryTombstoneTable)
        .values({ aggregate_id: "checkpoint_deleted", event_id: deletedEvent, seq: 0 })
        .run()
        .pipe(Effect.orDie)
      return [
        { id: projectEvent, aggregateID: projectID, seq: 0 },
        { id: sessionEvent, aggregateID: sessionID, seq: 0 },
        { id: "evt_checkpoint_message", aggregateID: sessionID, seq: 1 },
        { id: "evt_checkpoint_part", aggregateID: sessionID, seq: 2 },
      ]
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

function seedFiles(filename: string) {
  const db = new DatabaseSync(filename)
  try {
    db.exec("PRAGMA journal_mode=WAL")
    db.exec(
      "CREATE TABLE file (path TEXT PRIMARY KEY, type TEXT NOT NULL, mode INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT, content BLOB)",
    )
    const insert = db.prepare("INSERT INTO file VALUES (?, ?, ?, ?, ?, ?)")
    insert.run("synthetic", "directory", 448, 0, null, null)
    const text = Buffer.from("synthetic checkpoint file payload")
    const binary = Buffer.from([0, 1, 127, 255])
    insert.run("synthetic/transcript.txt", "file", 384, text.length, checksum(text), text)
    insert.run("synthetic/data.bin", "file", 384, binary.length, checksum(binary), binary)
  } finally {
    db.close()
  }
}

function checksum(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
