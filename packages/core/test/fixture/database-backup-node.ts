import assert from "node:assert/strict"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { randomBytes } from "node:crypto"
import { readdir } from "node:fs/promises"
import { Effect } from "effect"
import { DatabaseBackup } from "../../src/database/backup"

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
console.log("DATABASE_BACKUP_NODE_OK")
