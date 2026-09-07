export * as DatabaseBackup from "./backup"

import { EffectDrizzleSqlite } from "@mongolgpt/effect-drizzle-sqlite"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { lstat, open, mkdtemp, link, unlink, rmdir } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { protectBackupPath } from "./backup-permissions"

const magic = Buffer.from("MONGOLGPT-SQLITE-BACKUP\0\x01")
const nonceBytes = 12
const tagBytes = 16
const chunkBytes = 128 * 1024
const maxBytes = 16 * 1024 * 1024 * 1024

export class BackupError extends Schema.TaggedErrorClass<BackupError>()("DatabaseBackupError", {
  message: Schema.String,
}) {}

export interface Report {
  format: "mongolgpt-sqlite-backup-v1"
  bytes: number
  sha256: string
  schemaSha256: string
  tables: ReadonlyArray<{ name: string; rows: number }>
}

interface Options {
  source: string
  destination: string
  key: Uint8Array
}

/** A consistent logical SQLite snapshot, including WAL commits, without applying migrations. */
export function create(input: Options) {
  return operation(async (signal) => {
    const paths = await validate(input, false)
    return staging(paths.destination, async (directory) => {
      const snapshot = join(directory, "snapshot.sqlite")
      // Reserve private plaintext storage before SQLite writes into the empty file.
      await withFile(snapshot, "wx", async () => {})
      const sqlite = await import("#sqlite")
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* EffectDrizzleSqlite.makeWithDefaults()
          yield* db.run("PRAGMA trusted_schema = OFF")
          yield* db.run("PRAGMA busy_timeout = 5000")
          yield* db.run("PRAGMA synchronous = FULL")
          yield* db.run(sql`VACUUM INTO ${snapshot}`)
        }).pipe(
          Effect.provide(
            sqlite.layer({ filename: paths.source, readonly: true, readwrite: false, create: false, disableWAL: true }),
          ),
          Effect.scoped,
        ),
        { signal },
      ).catch(() => {
        throw new BackupError({ message: "Эх сангаас SQLite нөөц үүсгэж чадсангүй." })
      })
      const report = await inspect(snapshot, signal).catch(() => {
        throw new BackupError({ message: "Үүсгэсэн SQLite нөөцийн бүрэн бүтэн байдлыг шалгаж чадсангүй." })
      })
      const archive = join(directory, "archive")
      await encrypt(snapshot, archive, input.key, signal).catch(() => {
        throw new BackupError({ message: "SQLite нөөцийг шифрлэж чадсангүй." })
      })
      // A backup is not published until a real decrypt/reopen drill has passed.
      const restored = join(directory, "restored.sqlite")
      await decrypt(archive, restored, input.key, signal).catch(() => {
        throw new BackupError({ message: "Нөөцийг буцаан тайлж шалгаж чадсангүй." })
      })
      const verified = await inspect(restored, signal).catch(() => {
        throw new BackupError({
          message: "Туршилтаар сэргээсэн SQLite сангийн бүрэн бүтэн байдлыг баталгаажуулж чадсангүй.",
        })
      })
      if (JSON.stringify(report) !== JSON.stringify(verified)) throw invalid()
      signal.throwIfAborted()
      await publish(archive, paths.destination).catch(() => {
        throw new BackupError({ message: "Шалгасан нөөцийг зорилтот замд хадгалж чадсангүй." })
      })
      return report
    })
  })
}

/** Restores only to a new path; never opens the result through migration or session startup. */
export function restore(input: Options) {
  return operation(async (signal) => {
    const paths = await validate(input, true)
    return staging(paths.destination, async (directory) => {
      const restored = join(directory, "restored.sqlite")
      await decrypt(paths.source, restored, input.key, signal)
      const report = await inspect(restored, signal)
      signal.throwIfAborted()
      await assertAbsent(paths.destination, true)
      await publish(restored, paths.destination)
      return report
    })
  })
}

function operation<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.callback<A, BackupError>((resume, signal) => {
    const pending = run(signal).then(
      (result) => resume(Effect.succeed(result)),
      (error) =>
        resume(
          Effect.fail(
            // Native errors can contain SQL, file paths or credential-bearing database contents.
            error instanceof BackupError
              ? error
              : new BackupError({
                  message: "Нөөцлөх эсвэл сэргээх үйлдэл амжилтгүй боллоо. Эх өгөгдлийн санг өөрчлөөгүй.",
                }),
          ),
        ),
    )
    // On interruption, wait for native handles and plaintext staging cleanup before returning.
    return Effect.promise(() => pending)
  })
}

async function validate(input: Options, restoring: boolean) {
  if (input.key.byteLength !== 32) throw new BackupError({ message: "Нөөцийн шифрлэлтийн түлхүүр 32 байт байх ёстой." })
  const source = resolve(input.source)
  const destination = resolve(input.destination)
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > maxBytes + 128) throw invalid()
  await assertAbsent(destination, restoring)
  return { source, destination }
}

async function assertAbsent(destination: string, sqlite: boolean) {
  for (const suffix of sqlite ? ["", "-wal", "-shm", "-journal"] : [""]) {
    const info = await lstat(destination + suffix).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (info)
      throw new BackupError({ message: "Зорилтот файл эсвэл SQLite-ийн дагалдах файл байна. Өөр шинэ зам сонгоно уу." })
  }
}

async function staging<A>(destination: string, run: (directory: string) => Promise<A>) {
  // Staging must be on the destination filesystem for atomic, no-replace publication.
  const directory = await mkdtemp(join(dirname(destination), ".mongolgpt-backup-"))
  try {
    await protectBackupPath(directory, "directory")
    return await run(directory)
  } finally {
    // Only our fixed filenames, never recursive cleanup of a caller-supplied path.
    for (const filename of ["snapshot.sqlite", "restored.sqlite", "archive"]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        await unlink(join(directory, filename + suffix)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw new BackupError({ message: "Нөөцийн түр файлыг цэвэрлэж чадсангүй." })
        })
      }
    }
    await rmdir(directory).catch(() => {
      throw new BackupError({ message: "Нөөцийн түр хавтсыг цэвэрлэж чадсангүй." })
    })
  }
}

async function withFile<A>(filename: string, flags: string, run: (file: FileHandle) => Promise<A>) {
  const file = await open(filename, flags, 0o600)
  try {
    if (flags.includes("x")) await protectBackupPath(filename, "file")
    return await run(file)
  } finally {
    await file.close()
  }
}

async function publish(source: string, destination: string) {
  // link fails atomically if any destination already exists (including a symlink).
  await withFile(source, "r+", (file) => file.sync())
  await link(source, destination)
  if (process.platform !== "win32") await withFile(dirname(destination), "r", (file) => file.sync())
}

async function inspect(filename: string, signal: AbortSignal): Promise<Report> {
  const bytes = (await lstat(filename)).size
  if (bytes < 512 || bytes > maxBytes) throw invalid()
  const sqlite = await import("#sqlite")
  const inventory = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA trusted_schema = OFF")
      yield* db.run("PRAGMA query_only = ON")
      const integrity = yield* db.all<{ integrity_check: string }>(sql`PRAGMA integrity_check(1)`)
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") return yield* invalid()
      if (yield* db.get(sql`SELECT 1 FROM pragma_foreign_key_check LIMIT 1`)) return yield* invalid()
      const schema = yield* db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
        sql`SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name`,
      )
      const tables = yield* Effect.forEach(
        schema.filter((item) => item.type === "table"),
        (table) =>
          Effect.gen(function* () {
            const count = yield* db.get<{ count: number }>(
              sql`SELECT count(*) AS count FROM ${sql.identifier(table.name)}`,
            )
            if (!count || !Number.isSafeInteger(count.count) || count.count < 0) return yield* invalid()
            return { name: table.name, rows: count.count }
          }),
      )
      return { schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"), tables }
    }).pipe(
      Effect.provide(sqlite.layer({ filename, readonly: true, readwrite: false, create: false, disableWAL: true })),
      Effect.scoped,
    ),
    { signal },
  )
  const digest = createHash("sha256")
  await withFile(filename, "r", async (file) => {
    await chunks(file, 0, bytes, signal, async (chunk) => {
      digest.update(chunk)
    })
  })
  return { format: "mongolgpt-sqlite-backup-v1", bytes, sha256: digest.digest("hex"), ...inventory }
}

async function encrypt(source: string, destination: string, key: Uint8Array, signal: AbortSignal) {
  const nonce = randomBytes(nonceBytes)
  const header = Buffer.concat([magic, nonce])
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(header)
  await withFile(source, "r", async (input) => {
    const size = (await input.stat()).size
    if (size > maxBytes) throw invalid()
    await withFile(destination, "wx", async (output) => {
      await output.writeFile(header)
      await chunks(input, 0, size, signal, async (chunk) => {
        await output.writeFile(cipher.update(chunk))
      })
      await output.writeFile(cipher.final())
      await output.writeFile(cipher.getAuthTag())
      await output.sync()
    })
  })
}

async function decrypt(source: string, destination: string, key: Uint8Array, signal: AbortSignal) {
  await withFile(source, "r", async (input) => {
    const size = (await input.stat()).size
    const header = Buffer.alloc(magic.length + nonceBytes)
    const tag = Buffer.alloc(tagBytes)
    const length = size - header.length - tagBytes
    if (length < 512 || length > maxBytes) throw invalid()
    if ((await input.read(header, 0, header.length, 0)).bytesRead !== header.length) throw invalid()
    if (!header.subarray(0, magic.length).equals(magic)) throw invalid()
    if ((await input.read(tag, 0, tag.length, size - tagBytes)).bytesRead !== tagBytes) throw invalid()
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(magic.length))
    decipher.setAAD(header)
    decipher.setAuthTag(tag)
    await withFile(destination, "wx", async (output) => {
      await chunks(input, header.length, length, signal, async (chunk) => {
        await output.writeFile(decipher.update(chunk))
      })
      // Until final() authenticates every byte, plaintext stays in private staging.
      await output.writeFile(decipher.final())
      await output.sync()
    })
  })
}

async function chunks(
  file: FileHandle,
  offset: number,
  size: number,
  signal: AbortSignal,
  consume: (chunk: Buffer) => Promise<void>,
) {
  const buffer = Buffer.alloc(chunkBytes)
  for (let position = 0; position < size; ) {
    signal.throwIfAborted()
    const read = await file.read(buffer, 0, Math.min(buffer.length, size - position), offset + position)
    if (!read.bytesRead) throw invalid()
    await consume(buffer.subarray(0, read.bytesRead))
    position += read.bytesRead
  }
}

function invalid() {
  return new BackupError({
    message: "Нөөцийн файл эсвэл өгөгдлийн сангийн бүрэн бүтэн байдлыг баталгаажуулж чадсангүй.",
  })
}
