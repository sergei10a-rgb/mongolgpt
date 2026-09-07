import assert from "node:assert/strict"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { randomBytes } from "node:crypto"
import { readdir } from "node:fs/promises"
import { Effect } from "effect"
import { DatabaseBackup } from "../../src/database/backup"
import { DatabaseCheckpoint } from "../../src/database/checkpoint"

const root = process.argv[2]
assert(root)
const source = join(root, "node-source.sqlite")
const destination = join(root, "node-restored.sqlite")
const archive = join(root, "node.backup")
const key = randomBytes(32)
const db = new DatabaseSync(source)
db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
for (let index = 0; index < 30; index++) {
  db.exec(`CREATE TABLE fixture_${index} (id INTEGER PRIMARY KEY, data BLOB, wide INTEGER)`)
  db.exec(`INSERT INTO fixture_${index} VALUES (1,zeroblob(10000),9223372036854775807)`)
}
db.exec("BEGIN IMMEDIATE; DELETE FROM fixture_0")
const backup = await Effect.runPromise(DatabaseBackup.create({ source, destination: archive, key }))
assert.equal(backup.tables.length, 30)
assert(backup.tables.every((table) => table.rows === 1))
db.exec("ROLLBACK")
db.close()
const restored = await Effect.runPromise(DatabaseBackup.restore({ source: archive, destination, key }))
assert.deepEqual(restored, backup)
assert.deepEqual(await Effect.runPromise(DatabaseBackup.verify({ source: destination, expected: restored })), restored)
await assert.rejects(Effect.runPromise(DatabaseCheckpoint.inspect({ source: destination, expected: restored })))
const check = new DatabaseSync(destination, { readOnly: true })
const statement = check.prepare("SELECT wide, length(data) AS bytes FROM fixture_29")
statement.setReadBigInts(true)
assert.deepEqual({ ...statement.get() }, { wide: 9223372036854775807n, bytes: 10000n })
check.close()
await assert.rejects(Effect.runPromise(DatabaseBackup.restore({ source: archive, destination, key })))
await assert.rejects(
  Effect.runPromise(
    DatabaseBackup.restore({ source: archive, destination: join(root, "wrong.sqlite"), key: randomBytes(32) }),
  ),
)
assert(!(await readdir(root)).some((name) => name.startsWith(".mongolgpt-backup-")))
assert(!(await readdir(root)).includes("wrong.sqlite"))

// This deliberately has no app migration metadata. Inspection must stay read-only.
const checkpointSource = join(root, "checkpoint-source.sqlite")
const checkpointArchive = join(root, "checkpoint.backup")
const checkpointDestination = join(root, "checkpoint-restored.sqlite")
const checkpointDB = new DatabaseSync(checkpointSource)
checkpointDB.exec(`
  CREATE TABLE project (id TEXT PRIMARY KEY);
  CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id));
  CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
  CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT REFERENCES event_sequence(aggregate_id), seq INTEGER, type TEXT, data TEXT);
  CREATE TABLE cloud_history_tombstone (aggregate_id TEXT PRIMARY KEY, event_id TEXT UNIQUE, seq INTEGER);
  INSERT INTO project VALUES ('project_node');
  INSERT INTO session VALUES ('ses_node', 'project_node');
  INSERT INTO event_sequence VALUES ('ses_node', 0);
`)
checkpointDB.prepare("INSERT INTO event VALUES (?, ?, ?, ?, ?)").run(
  "evt_node_created",
  "ses_node",
  0,
  "session.created.1",
  JSON.stringify({
    sessionID: "ses_node",
    info: {
      id: "ses_node",
      projectID: "project_node",
      slug: "node",
      directory: "/synthetic",
      title: "Synthetic checkpoint",
      version: "test",
      time: { created: 1, updated: 1 },
    },
  }),
)
checkpointDB.close()
const checkpointReport = await Effect.runPromise(
  DatabaseBackup.create({ source: checkpointSource, destination: checkpointArchive, key }),
)
await Effect.runPromise(DatabaseBackup.restore({ source: checkpointArchive, destination: checkpointDestination, key }))
const inventory = await Effect.runPromise(
  DatabaseCheckpoint.inspect({ source: checkpointDestination, expected: checkpointReport }),
)
assert.deepEqual(inventory.projects, [{ id: "project_node", journaled: false }])
assert.deepEqual(inventory.sessions, [{ id: "ses_node", projectID: "project_node", journaled: true }])
assert.deepEqual(inventory.counts, { events: 1, tombstones: 0 })
assert.equal(inventory.aggregates[0].seq, 0)
assert.match(inventory.aggregates[0].sha256, /^[0-9a-f]{64}$/)
assert.deepEqual(
  await Effect.runPromise(DatabaseBackup.verify({ source: checkpointDestination, expected: checkpointReport })),
  checkpointReport,
)
assert(!(await readdir(root)).some((name) => name.startsWith("checkpoint-restored.sqlite-")))
console.log("DATABASE_CHECKPOINT_NODE_OK")
console.log("DATABASE_BACKUP_NODE_OK")
