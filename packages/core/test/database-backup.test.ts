import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { readFile, writeFile, readdir, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@mongolgpt/core/database/database"
import { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { EffectDrizzleSqlite } from "@mongolgpt/effect-drizzle-sqlite"
import { tmpdir } from "./fixture/tmpdir"

const marker = "synthetic-backup-credential-not-a-real-secret"

async function seed(filename: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      for (const statement of [
        "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes,name) VALUES ('p','/synthetic',1,2,'[]','Монгол төсөл')",
        "INSERT INTO project_directory (project_id,directory,time_created) VALUES ('p','/synthetic/extra',3)",
        "INSERT INTO workspace (id,type,project_id,time_used) VALUES ('w','local','p',4)",
        "INSERT INTO session (id,project_id,workspace_id,slug,directory,title,version,time_created,time_updated) VALUES ('s','p','w','s','/synthetic','Хадгалах сешн','test',5,6)",
        "INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('m','s',7,8,'{\"legacy\":true}')",
        "INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('part','m','s',9,10,'{\"text\":\"хуучин\"}')",
        "INSERT INTO todo (session_id,content,status,priority,position,time_created,time_updated) VALUES ('s','хийх ажил','pending','high',0,11,12)",
        "INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES ('v2','s','user',0,13,14,'{\"text\":\"шинэ\"}')",
        "INSERT INTO session_input (id,session_id,prompt,delivery,admitted_seq,time_created) VALUES ('pending','s','{\"text\":\"хүлээгдэж буй\"}','queue',1,15)",
        "INSERT INTO session_context_epoch (session_id,baseline,snapshot,baseline_seq) VALUES ('s','[]','{\"preserve\":true}',0)",
        "INSERT INTO event_sequence (aggregate_id,seq,owner_id) VALUES ('s',1,'original-owner')",
        "INSERT INTO event (id,aggregate_id,seq,type,data) VALUES ('event','s',1,'synthetic.history.1','{\"preserve\":true}')",
        "INSERT INTO cloud_history_tombstone (aggregate_id,event_id,seq) VALUES ('erased','erase-event',2)",
        "INSERT INTO permission (id,project_id,action,resource,time_created,time_updated) VALUES ('permission','p','read','/synthetic',16,17)",
        "INSERT INTO data_migration (name,time_completed) VALUES ('synthetic-migration',18)",
        "INSERT INTO account (id,email,url,access_token,refresh_token,time_created,time_updated) VALUES ('account','fixture@example.invalid','https://example.invalid','synthetic-access','synthetic-refresh',19,20)",
        "INSERT INTO account_state (id,active_account_id) VALUES (1,'account')",
        "INSERT INTO control_account (email,url,access_token,refresh_token,active,time_created,time_updated) VALUES ('fixture@example.invalid','https://example.invalid','synthetic-control','synthetic-refresh',1,21,22)",
        "INSERT INTO session_share (session_id,id,secret,url,time_created,time_updated) VALUES ('s','share','synthetic-share','https://example.invalid',23,24)",
        "INSERT INTO background_job (namespace,id,type,status,started_at,owner_token,generation,heartbeat_at,time_created,time_updated) VALUES ('s','job','test','running',25,'synthetic-owner',1,26,27,28)",
        "CREATE TABLE future_extension (id INTEGER PRIMARY KEY, data BLOB, wide INTEGER)",
        "INSERT INTO future_extension VALUES (7,zeroblob(350000),9223372036854775807)",
      ])
        yield* database.db.run(sql.raw(statement))
      yield* database.db.run(
        sql`INSERT INTO credential (id,label,value,time_created,time_updated) VALUES ('credential','test',${marker},29,30)`,
      )
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

async function rows(filename: string) {
  const native = await import("bun:sqlite")
  const db = new native.Database(filename, { readonly: true })
  try {
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all()
    return Object.fromEntries(
      tables.map(({ name }) => {
        const statement = db.query(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY 1`)
        // Bun supports this API before the pinned bun-types declaration does.
        ;(statement as typeof statement & { safeIntegers(value: boolean): void }).safeIntegers(true)
        return [name, statement.values()]
      }),
    )
  } finally {
    db.close()
  }
}

describe("encrypted SQLite preservation", () => {
  test("readonly adapter does not switch journal mode and releases uncached statement handles", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "readonly.sqlite")
    const native = await import("bun:sqlite")
    const writer = new native.Database(source)
    writer.run("CREATE TABLE fixture (id INTEGER PRIMARY KEY)")
    writer.run("INSERT INTO fixture VALUES (1)")
    writer.close()
    const sqlite = await import("../src/database/sqlite.bun")
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        expect(yield* db.get(sql`PRAGMA journal_mode`)).toEqual({ journal_mode: "delete" })
        for (let index = 0; index < 40; index++) {
          expect(yield* db.all(sql.raw(`SELECT id AS field_${index} FROM fixture`))).toEqual([
            { [`field_${index}`]: 1 },
          ])
          expect(yield* db.values(sql.raw(`SELECT id AS value_${index} FROM fixture`))).toEqual([[1]])
        }
      }).pipe(
        Effect.provide(sqlite.layer({ filename: source, readonly: true, readwrite: false, create: false })),
        Effect.scoped,
      ),
    )
    const before = await readFile(source)
    expect(await rows(source)).toEqual({ fixture: [[1n]] })
    expect(await readFile(source)).toEqual(before)
  })
  test("preserves every table, identity, pending input, tombstone, credential, wide integer and large blob", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source.sqlite")
    const archive = join(temp.path, "full.backup")
    const destination = join(temp.path, "restored.sqlite")
    const key = randomBytes(32)
    await seed(source)
    const before = await rows(source)
    const backup = await Effect.runPromise(DatabaseBackup.create({ source, destination: archive, key }))
    expect(backup.tables.length).toBe(Object.keys(before).length)
    expect(backup.tables.length).toBeGreaterThan(20)
    expect(backup.tables.find((table) => table.name === "session_input")?.rows).toBe(1)
    expect((await readFile(archive)).includes(Buffer.from(marker))).toBe(false)
    expect((await readFile(archive)).includes(Buffer.from("SQLite format 3"))).toBe(false)
    const restored = await Effect.runPromise(DatabaseBackup.restore({ source: archive, destination, key }))
    expect(restored).toEqual(backup)
    expect(await rows(destination)).toEqual(before)
    expect(await rows(source)).toEqual(before)
    expect((await readdir(temp.path)).some((file) => file.startsWith(".mongolgpt-backup-"))).toBe(false)
    if (process.platform !== "win32") expect((await stat(destination)).mode & 0o777).toBe(0o600)
    if (process.platform === "win32") {
      const permissions = await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($rule in [IO.File]::GetAccessControl($env:MONGOLGPT_BACKUP_TEST_PATH).Access) { $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($sid -eq $me){'self'}elseif($sid -eq 'S-1-5-18'){'system'}else{'other'} }",
        ],
        { windowsHide: true, timeout: 10_000, env: { ...process.env, MONGOLGPT_BACKUP_TEST_PATH: destination } },
      )
      expect(permissions.stderr).toBe("")
      expect(permissions.stdout.trim().split(/\r?\n/)).toEqual(expect.arrayContaining(["self", "system"]))
      expect(permissions.stdout).not.toContain("other")
    }
  })

  test("snapshots committed WAL state without uncommitted rows or source migration", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "legacy.sqlite")
    const archive = join(temp.path, "wal.backup")
    const destination = join(temp.path, "wal-restored.sqlite")
    const key = randomBytes(32)
    const native = await import("bun:sqlite")
    const db = new native.Database(source)
    try {
      db.run("PRAGMA journal_mode=WAL")
      db.run("PRAGMA wal_autocheckpoint=0")
      db.run("CREATE TABLE legacy_content (id TEXT PRIMARY KEY, value TEXT)")
      db.run("INSERT INTO legacy_content VALUES ('committed','kept')")
      db.run("BEGIN IMMEDIATE")
      db.run("INSERT INTO legacy_content VALUES ('uncommitted','not-snapshot')")
      const report = await Effect.runPromise(DatabaseBackup.create({ source, destination: archive, key }))
      expect(report.tables).toEqual([{ name: "legacy_content", rows: 1 }])
      db.run("COMMIT")
      await Effect.runPromise(DatabaseBackup.restore({ source: archive, destination, key }))
      expect(await rows(destination)).toEqual({ legacy_content: [["committed", "kept"]] })
      expect((await rows(source)).legacy_content).toHaveLength(2)
      expect(await readdir(temp.path)).not.toContain("migration")
    } finally {
      db.close()
    }
  })

  test("never creates a missing source or overwrites an existing destination or SQLite sidecar", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source.sqlite")
    const archive = join(temp.path, "archive")
    const key = randomBytes(32)
    await expect(Effect.runPromise(DatabaseBackup.create({ source, destination: archive, key }))).rejects.toThrow()
    expect(await readdir(temp.path)).toEqual([])
    await seed(source)
    const before = await rows(source)
    await expect(Effect.runPromise(DatabaseBackup.create({ source, destination: source, key }))).rejects.toThrow(
      "Зорилтот",
    )
    await writeFile(archive, "existing")
    await expect(Effect.runPromise(DatabaseBackup.create({ source, destination: archive, key }))).rejects.toThrow(
      "Зорилтот",
    )
    expect(await readFile(archive, "utf8")).toBe("existing")
    const valid = join(temp.path, "valid")
    await Effect.runPromise(DatabaseBackup.create({ source, destination: valid, key }))
    await expect(
      Effect.runPromise(DatabaseBackup.restore({ source: valid, destination: source, key })),
    ).rejects.toThrow("Зорилтот")
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const destination = join(temp.path, `restore-${suffix}`)
      await writeFile(destination + suffix, "keep-sidecar")
      await expect(Effect.runPromise(DatabaseBackup.restore({ source: valid, destination, key }))).rejects.toThrow(
        "Зорилтот",
      )
      expect(await readFile(destination + suffix, "utf8")).toBe("keep-sidecar")
    }
    expect(await rows(source)).toEqual(before)
  })

  test("rejects wrong keys, modified headers, ciphertext, tags and truncated archives without publishing plaintext", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source.sqlite")
    const archive = join(temp.path, "archive")
    const key = randomBytes(32)
    await seed(source)
    await Effect.runPromise(DatabaseBackup.create({ source, destination: archive, key }))
    const bytes = await readFile(archive)
    const wrong = join(temp.path, "wrong.sqlite")
    await expect(
      Effect.runPromise(DatabaseBackup.restore({ source: archive, destination: wrong, key: randomBytes(32) })),
    ).rejects.toThrow()
    for (const position of [0, 26, 100, bytes.length - 1, bytes.length]) {
      const altered = Buffer.from(bytes)
      if (position < altered.length) altered[position] ^= 1
      const input = join(temp.path, `altered-${position}`)
      const destination = join(temp.path, `restored-${position}`)
      await writeFile(input, position === bytes.length ? altered.subarray(0, bytes.length - 8) : altered)
      await expect(Effect.runPromise(DatabaseBackup.restore({ source: input, destination, key }))).rejects.toThrow()
      expect(await readdir(temp.path)).not.toContain(`restored-${position}`)
    }
    expect((await readdir(temp.path)).some((file) => file.startsWith(".mongolgpt-backup-"))).toBe(false)
    expect(await readdir(temp.path)).not.toContain("wrong.sqlite")
  })

  test("publishes exactly one complete archive when two backups target the same new file", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source.sqlite")
    const destination = join(temp.path, "archive")
    const key = randomBytes(32)
    await seed(source)
    const result = await Effect.runPromise(
      Effect.all(
        [
          Effect.exit(DatabaseBackup.create({ source, destination, key })),
          Effect.exit(DatabaseBackup.create({ source, destination, key })),
        ],
        { concurrency: 2 },
      ),
    )
    expect(result.filter((item) => item._tag === "Success")).toHaveLength(1)
    expect(result.filter((item) => item._tag === "Failure")).toHaveLength(1)
    const restored = join(temp.path, "restored.sqlite")
    await Effect.runPromise(DatabaseBackup.restore({ source: destination, destination: restored, key }))
    expect(await rows(restored)).toEqual(await rows(source))
    expect((await readdir(temp.path)).some((file) => file.startsWith(".mongolgpt-backup-"))).toBe(false)
  })

  test("interruption waits for private staging cleanup and leaves source intact", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source.sqlite")
    const destination = join(temp.path, "archive")
    const native = await import("bun:sqlite")
    const db = new native.Database(source)
    db.run("CREATE TABLE interrupt_fixture (id INTEGER PRIMARY KEY, payload BLOB)")
    db.run("INSERT INTO interrupt_fixture VALUES (1, zeroblob(4194304))")
    db.close()
    const before = await readFile(source)
    const controller = new AbortController()
    const running = Effect.runPromise(DatabaseBackup.create({ source, destination, key: randomBytes(32) }), {
      signal: controller.signal,
    })
    const failed = running.catch(() => "interrupted")
    const deadline = Date.now() + 5000
    while (
      !(await readdir(temp.path, { withFileTypes: true })).some(
        (entry) => entry.isDirectory() && entry.name.startsWith(".mongolgpt-backup-"),
      )
    ) {
      if (Date.now() > deadline) throw new Error("backup staging was not created")
      await Bun.sleep(5)
    }
    controller.abort()
    expect(await failed).toBe("interrupted")
    expect((await readdir(temp.path)).some((name) => name.startsWith(".mongolgpt-backup-"))).toBe(false)
    expect(await readdir(temp.path)).not.toContain("archive")
    expect(await readFile(source)).toEqual(before)
    expect((await rows(source)).interrupt_fixture).toHaveLength(1)
  })

  test("rejects invalid keys and foreign-key violations without mutating source or exposing raw data", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "broken.sqlite")
    const destination = join(temp.path, "backup")
    const native = await import("bun:sqlite")
    const db = new native.Database(source)
    db.run("PRAGMA foreign_keys=OFF")
    db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
    db.run("CREATE TABLE child (id INTEGER REFERENCES parent(id), value TEXT)")
    db.query("INSERT INTO child VALUES (1, ?)").run(marker)
    db.close()
    await expect(
      Effect.runPromise(DatabaseBackup.create({ source, destination, key: randomBytes(31) })),
    ).rejects.toThrow("32 байт")
    const result = await Effect.runPromise(
      Effect.exit(DatabaseBackup.create({ source, destination, key: randomBytes(32) })),
    )
    expect(result._tag).toBe("Failure")
    expect(JSON.stringify(result)).not.toContain(marker)
    expect((await rows(source)).child).toEqual([[1n, marker]])
    expect(await readdir(temp.path)).toEqual(["broken.sqlite"])
  })

  test.skipIf(process.platform === "win32")("does not follow destination symlinks", async () => {
    await using temp = await tmpdir()
    const source = join(temp.path, "source.sqlite")
    const destination = join(temp.path, "link")
    await seed(source)
    await symlink(join(temp.path, "absent-target"), destination)
    await expect(
      Effect.runPromise(DatabaseBackup.create({ source, destination, key: randomBytes(32) })),
    ).rejects.toThrow("Зорилтот")
    expect(await readdir(temp.path)).not.toContain("absent-target")
  })
})
