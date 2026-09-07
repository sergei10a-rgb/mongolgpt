export { Effect } from "effect"

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { DatabaseBackup } from "../../../core/src/database/backup"

export const credentialMarker = "runtime-r2-backup-credential-not-a-real-secret"

export async function createFixture(root: string, archiveKeyHex: string) {
  const source = join(root, "r2-source.sqlite")
  const archive = join(root, "r2-source.backup")
  seed(source)
  const rows = readRows(source)
  const report = await Effect.runPromise(
    DatabaseBackup.create({ source, destination: archive, key: Buffer.from(archiveKeyHex, "hex") }),
  )
  const bytes = await readFile(archive)
  return { source, archive, rows, report, bytes: bytes.length, sha256: checksum(bytes) }
}

export async function restoreRows(input: { archive: string; destination: string; keyHex: string }) {
  const report = await Effect.runPromise(
    DatabaseBackup.restore({
      source: input.archive,
      destination: input.destination,
      key: Buffer.from(input.keyHex, "hex"),
    }),
  )
  return { report, rows: readRows(input.destination) }
}

export async function assertRestoreFails(input: { archive: string; destination: string; keyHex: string }) {
  await assert.rejects(
    Effect.runPromise(
      DatabaseBackup.restore({
        source: input.archive,
        destination: input.destination,
        key: Buffer.from(input.keyHex, "hex"),
      }),
    ),
  )
}

function seed(filename: string) {
  const db = new DatabaseSync(filename)
  try {
    db.exec("PRAGMA journal_mode=WAL")
    db.exec("PRAGMA wal_autocheckpoint=0")
    db.exec("CREATE TABLE credential (id TEXT PRIMARY KEY, label TEXT NOT NULL, value TEXT NOT NULL)")
    db.exec("CREATE TABLE payload (id TEXT PRIMARY KEY, data BLOB NOT NULL, wide INTEGER NOT NULL)")
    db.prepare("INSERT INTO credential VALUES (?, ?, ?)").run("cred_r2", "R2 backup fixture", credentialMarker)
    db.prepare("INSERT INTO payload VALUES (?, ?, ?)").run("large", largePayload(), 9223372036854775807n)
  } finally {
    db.close()
  }
}

function readRows(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    return {
      credentials: db.prepare("SELECT id, label, value FROM credential ORDER BY id").all(),
      payloads: db
        .prepare(
          "SELECT id, length(data) AS bytes, hex(substr(data, 1, 16)) AS prefix, CAST(wide AS TEXT) AS wide FROM payload ORDER BY id",
        )
        .all(),
    }
  } finally {
    db.close()
  }
}

function largePayload() {
  const value = Buffer.allocUnsafe(9 * 1024 * 1024 + 4096)
  for (let index = 0; index < value.length; index++) value[index] = (index * 31) % 251
  return value
}

function checksum(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
