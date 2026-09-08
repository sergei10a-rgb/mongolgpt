import { Database } from "bun:sqlite"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { DatabaseCheckpoint } from "@mongolgpt/core/database/checkpoint"
import { WorkspaceCapture } from "@mongolgpt/core/database/workspace-capture"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"

export async function cloudFilesSeed(directory: string) {
  const key = randomBytes(32)
  const filename = join(directory, "seed.sqlite")
  const database = new Database(filename)
  try {
    database.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT);
      CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER);
    `)
  } finally {
    database.close()
  }
  const sqlitePath = join(directory, "sqlite.backup")
  const sqlite = await Effect.runPromise(DatabaseBackup.create({ source: filename, destination: sqlitePath, key }))
  const restored = join(directory, "seed-restored.sqlite")
  await Effect.runPromise(DatabaseBackup.restore({ source: sqlitePath, destination: restored, key }))
  const inventory = await Effect.runPromise(DatabaseCheckpoint.inspect({ source: restored, expected: sqlite }))
  const source = join(directory, "seed-files")
  await mkdir(join(source, "project"), { recursive: true })
  await writeFile(join(source, "project/readme.txt"), "synthetic checkpoint")
  const filesPath = join(directory, "files.backup")
  const files = await Effect.runPromise(WorkspaceCapture.create({ source, destination: filesPath, key }))
  const bodies = new Map<string, Buffer>()
  async function reference(path: string, report: DatabaseBackup.Report): Promise<CloudCheckpoint.Archive> {
    const bytes = await readFile(path)
    const backupID = randomUUID()
    bodies.set(backupID, bytes)
    return {
      backupID,
      keyID: "synthetic",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      plaintext: { bytes: report.bytes, sha256: report.sha256 },
    }
  }
  const checkpoint: CloudCheckpoint.Checkpoint = {
    id: randomUUID(),
    inventory,
    sqlite: await reference(sqlitePath, sqlite),
    files: await reference(filesPath, files.report),
  }
  return { key, source, checkpoint, bodies }
}
