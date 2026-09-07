import { describe, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { Buffer } from "node:buffer"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

const keyHex = Buffer.alloc(32, 7).toString("hex")

async function writeKeyFile(directory: string, content = keyHex + "\n") {
  const keyFile = path.join(directory, "backup.key")
  await writeFile(keyFile, content, { mode: 0o600 })
  return keyFile
}

function createSyntheticDatabase(filename: string) {
  const db = new Database(filename, { create: true })
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE history (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE credentials (provider TEXT PRIMARY KEY, token TEXT NOT NULL);
      INSERT INTO metadata VALUES ('schema', 'synthetic');
      INSERT INTO history VALUES ('h1', 'hello');
      INSERT INTO history VALUES ('h2', 'world');
      INSERT INTO credentials VALUES ('test', 'secret-token');
    `)
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }
}

function tableNames(filename: string) {
  const db = new Database(filename, { readonly: true })
  try {
    return db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name)
  } finally {
    db.close()
  }
}

function historyRows(filename: string) {
  const db = new Database(filename, { readonly: true })
  try {
    return db.query<{ body: string }, []>("SELECT body FROM history ORDER BY id").all()
  } finally {
    db.close()
  }
}

describe("mongolgpt db backup/restore", () => {
  cliIt.live(
    "prints focused help for SQLite metadata/history/credentials backups",
    ({ mongolgpt }) =>
      Effect.gen(function* () {
        const backup = yield* mongolgpt.spawn(["db", "backup", "--help"], { env: { COLUMNS: "120" } })
        const restore = yield* mongolgpt.spawn(["db", "restore", "--help"], { env: { COLUMNS: "120" } })

        mongolgpt.expectExit(backup, 0, "db backup --help")
        mongolgpt.expectExit(restore, 0, "db restore --help")
        expect(backup.stderr).toContain("--source")
        expect(backup.stderr).toContain("--key-file")
        expect(backup.stderr).toContain("SQLite логик мета өгөгдөл, түүх, итгэмжлэлийн")
        expect(backup.stderr).toContain("Далд ROWID өөрчлөгдөж болох")
        expect(backup.stderr).toMatch(
          /Төслийн файл, тохиргоо, Git сан, R2 объект болон D1 рүү\s+шилжүүлэлт\s+хамрагдахгүй/,
        )
        expect(backup.stderr).toContain("итгэмжлэлийн нууцыг ил текстээр агуулна")
        expect(backup.stderr).toMatch(/Git-д\s+бүртгэхгүй/)
        expect(restore.stderr).toContain("--key-file")
        expect(restore.stderr).toContain("шифрлэсэн SQLite нөөцөөс шинэ өгөгдлийн сан сэргээх")
      }),
    60_000,
  )

  cliIt.live(
    "validates missing key file before loading runtime or touching the default database",
    ({ home, mongolgpt }) =>
      Effect.gen(function* () {
        const source = path.join(home, "source.sqlite")
        const backup = path.join(home, "source.backup")
        const missingKey = path.join(home, "missing.key")
        const defaultDb = path.join(home, "default-should-not-exist.sqlite")
        createSyntheticDatabase(source)

        const result = yield* mongolgpt.spawn(["db", "backup", backup, "--source", source, "--key-file", missingKey], {
          env: { MONGOLGPT_DB: defaultDb },
        })

        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("Шифрлэлтийн түлхүүрийн файл")
        expect(result.stderr).not.toContain(missingKey)
        yield* Effect.promise(async () => {
          expect(await Bun.file(defaultDb).exists()).toBe(false)
        })
      }),
    60_000,
  )

  cliIt.live(
    "rejects unknown cloud flags without opening the default database",
    ({ home, mongolgpt }) =>
      Effect.gen(function* () {
        const source = path.join(home, "source.sqlite")
        const backup = path.join(home, "source.backup")
        const defaultDb = path.join(home, "default-should-not-exist.sqlite")
        const keyFile = yield* Effect.promise(() => writeKeyFile(home))
        createSyntheticDatabase(source)

        const result = yield* mongolgpt.spawn(
          ["db", "backup", backup, "--source", source, "--key-file", keyFile, "--cloud"],
          { env: { MONGOLGPT_DB: defaultDb } },
        )

        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("mongolgpt db backup <destination>")
        yield* Effect.promise(async () => {
          expect(await Bun.file(defaultDb).exists()).toBe(false)
        })
      }),
    60_000,
  )

  cliIt.live(
    "refuses to overwrite an existing backup target with a sanitized error",
    ({ home, mongolgpt }) =>
      Effect.gen(function* () {
        const source = path.join(home, "source.sqlite")
        const backup = path.join(home, "existing.backup")
        const keyFile = yield* Effect.promise(() => writeKeyFile(home))
        createSyntheticDatabase(source)
        yield* Effect.promise(() => writeFile(backup, "already here"))

        const result = yield* mongolgpt.spawn(["db", "backup", backup, "--source", source, "--key-file", keyFile])

        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("Зорилтот файл")
        expect(result.stderr).not.toContain(source)
        expect(result.stderr).not.toContain(keyHex)
      }),
    60_000,
  )

  cliIt.live(
    "roundtrips a synthetic SQLite database without running CLI database migrations first",
    ({ home, mongolgpt }) =>
      Effect.gen(function* () {
        const source = path.join(home, "source.sqlite")
        const backup = path.join(home, "source.backup")
        const restored = path.join(home, "restored.sqlite")
        const keyFile = yield* Effect.promise(() => writeKeyFile(home))
        createSyntheticDatabase(source)

        const beforeTables = tableNames(source)
        const created = yield* mongolgpt.spawn(["db", "backup", backup, "--source", source, "--key-file", keyFile], {
          env: { MONGOLGPT_DB: source, MONGOLGPT_CLOUD_HISTORY: "invalid-must-not-load-runtime" },
        })
        mongolgpt.expectExit(created, 0, "db backup")
        expect(created.stdout).toContain("SQLite нөөц амжилттай үүслээ")
        expect(created.stdout).toContain('"metadata": 1 мөр')
        expect(created.stdout).toContain('"history": 2 мөр')
        expect(created.stdout).toContain('"credentials": 1 мөр')
        expect(created.stdout).toContain("Далд ROWID өөрчлөгдөж болох")
        expect(created.stdout).toContain(
          "Төслийн файл, тохиргоо, Git сан, R2 объект болон D1 рүү шилжүүлэлт хамрагдахгүй",
        )
        expect(created.stdout).toContain("итгэмжлэлийн нууцыг ил текстээр агуулна")
        expect(created.stdout).not.toContain(keyHex)
        expect(tableNames(source)).toEqual(beforeTables)

        const restoredResult = yield* mongolgpt.spawn(["db", "restore", backup, restored, "--key-file", keyFile])
        mongolgpt.expectExit(restoredResult, 0, "db restore")
        expect(restoredResult.stdout).toContain("SQLite өгөгдлийн сан амжилттай сэргээгдлээ")
        expect(tableNames(restored)).toEqual(beforeTables)
        expect(historyRows(restored)).toEqual([{ body: "hello" }, { body: "world" }])

        const archiveBytes = yield* Effect.promise(() => readFile(backup))
        expect(archiveBytes.includes(Buffer.from("secret-token"))).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "leaves db path and db query behavior unchanged",
    ({ mongolgpt }) =>
      Effect.gen(function* () {
        const dbPath = yield* mongolgpt.spawn(["db", "path"])
        mongolgpt.expectExit(dbPath, 0, "db path")
        expect(path.isAbsolute(dbPath.stdout.trim()) || dbPath.stdout.trim() === ":memory:").toBe(true)

        const query = yield* mongolgpt.spawn(["db", "select 42 as answer", "--format", "json"])
        mongolgpt.expectExit(query, 0, "db query")
        expect(JSON.parse(query.stdout)).toEqual([{ answer: 42 }])
      }),
    60_000,
  )
})
