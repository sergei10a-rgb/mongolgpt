import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator"
import { resolve } from "node:path"
import { z } from "zod"

const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_BATCH_BYTES = 1024 * 1024
const MIGRATIONS_TABLE = "__drizzle_migrations"

const ApiEnvelope = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number().optional() })).optional(),
  result: z
    .array(
      z.object({
        success: z.boolean().optional(),
        results: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    )
    .optional(),
})

const MigrationRow = z.object({
  id: z.number(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.union([z.number(), z.string()]).transform(Number),
  name: z.string().min(1),
})

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type Query = { sql: string; params: string[] }

export async function migrateD1(input: {
  accountId: string
  databaseId: string
  apiToken: string
  migrationsFolder?: string
  fetch?: Fetch
  now?: () => Date
  onApplied?: (name: string) => void
}) {
  const accountId = requireIdentifier("Cloudflare account ID", input.accountId, /^[a-f0-9]{32}$/)
  const databaseId = requireIdentifier(
    "D1 database ID",
    input.databaseId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  )
  const apiToken = input.apiToken.trim()
  if (!apiToken) throw new Error("Cloudflare API token дутуу байна.")

  const migrations = validateLocalMigrations(
    readMigrationFiles({
      migrationsFolder: input.migrationsFolder ?? resolve(import.meta.dir, "../migrations-d1"),
    }),
  )
  const request = createD1Request({ accountId, databaseId, apiToken, fetch: input.fetch })

  await request.single({
    sql: `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )`,
    params: [],
  })

  const rows = (
    await request.single({
      sql: `SELECT id, hash, created_at, name FROM ${MIGRATIONS_TABLE} ORDER BY created_at, id`,
      params: [],
    })
  ).map((row) => MigrationRow.parse(row))
  const pending = validateMigrationHistory(migrations, rows)

  if (!rows.length && (await hasUntrackedApplicationSchema(request))) {
    throw new Error("D1 schema байна, харин migration бүртгэл алга. Автоматаар давхар migration хийхээс татгалзлаа.")
  }

  for (const migration of pending) {
    const statements = migration.sql
      .filter((sql) => sql.trim())
      .map<Query>((sql) => ({ sql, params: [] }))
      .concat({
        sql: `INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)`,
        params: [migration.hash, String(migration.folderMillis), migration.name, (input.now ?? (() => new Date()))().toISOString()],
      })
    await request.batch(statements)
    input.onApplied?.(migration.name)
  }

  return { applied: pending.length, total: migrations.length }
}

function createD1Request(input: {
  accountId: string
  databaseId: string
  apiToken: string
  fetch?: Fetch
}) {
  const request = input.fetch ?? fetch
  const url = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}/query`

  async function post(body: { sql: string; params: string[] } | { batch: Query[] }, expectedResults: number) {
    const serialized = JSON.stringify(body)
    if (Buffer.byteLength(serialized) > MAX_BATCH_BYTES) throw new Error("D1 migration batch 1 MiB хязгаараас давлаа.")
    const response = await request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiToken}`,
        "Content-Type": "application/json",
      },
      body: serialized,
    })
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Cloudflare D1 хариу 1 MiB хязгаараас давлаа.")
    const payload = ApiEnvelope.parse(JSON.parse(text))
    const errorCodes = payload.errors?.flatMap((error) => (error.code === undefined ? [] : [String(error.code)])) ?? []
    if (!response.ok || !payload.success || !payload.result) {
      throw new Error(
        `Cloudflare D1 хүсэлт амжилтгүй (HTTP ${response.status}${errorCodes.length ? `, код ${errorCodes.join(",")}` : ""}).`,
      )
    }
    if (payload.result.length !== expectedResults) {
      throw new Error(`Cloudflare D1 ${expectedResults} үр дүнгийн оронд ${payload.result.length}-г буцаалаа.`)
    }
    const failed = payload.result.findIndex((result) => result.success !== true)
    if (failed >= 0) throw new Error(`Cloudflare D1 batch-ийн ${failed + 1}-р statement амжилтгүй боллоо.`)
    return payload.result
  }

  return {
    single: async (query: Query) => (await post(query, 1))[0]?.results ?? [],
    batch: async (queries: Query[]) => {
      await post({ batch: queries }, queries.length)
    },
  }
}

function validateLocalMigrations(migrations: MigrationMeta[]) {
  if (!migrations.length) throw new Error("D1 migration файл олдсонгүй.")
  const names = new Set<string>()
  for (const migration of migrations) {
    if (names.has(migration.name)) throw new Error(`D1 migration нэр давхардсан: ${migration.name}`)
    if (!/^[a-f0-9]{64}$/.test(migration.hash)) throw new Error(`D1 migration hash буруу: ${migration.name}`)
    if (!migration.sql.some((sql) => sql.trim())) throw new Error(`D1 migration хоосон байна: ${migration.name}`)
    names.add(migration.name)
  }
  return migrations
}

function validateMigrationHistory(migrations: MigrationMeta[], rows: z.infer<typeof MigrationRow>[]) {
  const local = new Map(migrations.map((migration) => [migration.name, migration]))
  const applied = new Set<string>()
  for (const row of rows) {
    if (!Number.isFinite(row.created_at)) throw new Error(`D1 migration хугацаа буруу: ${row.name}`)
    if (applied.has(row.name)) throw new Error(`D1 migration бүртгэл давхардсан: ${row.name}`)
    const migration = local.get(row.name)
    if (!migration) throw new Error(`D1-д local файлгүй migration бүртгэгдсэн: ${row.name}`)
    if (migration.hash !== row.hash) throw new Error(`D1 migration өөрчлөгдсөн байна: ${row.name}`)
    if (migration.folderMillis !== row.created_at) throw new Error(`D1 migration хугацаа зөрсөн байна: ${row.name}`)
    applied.add(row.name)
  }

  const firstPending = migrations.findIndex((migration) => !applied.has(migration.name))
  const pendingIndex = firstPending < 0 ? migrations.length : firstPending
  const gap = migrations.slice(pendingIndex).find((migration) => applied.has(migration.name))
  if (gap) throw new Error(`D1 migration дараалал тасарсан байна: ${gap.name}`)
  return migrations.slice(pendingIndex)
}

async function hasUntrackedApplicationSchema(request: ReturnType<typeof createD1Request>) {
  const rows = await request.single({
    sql: "SELECT name FROM sqlite_schema WHERE type IN ('table', 'trigger', 'view') AND name IN ('account', 'auth', 'workspace', 'usage') LIMIT 1",
    params: [],
  })
  return rows.length > 0
}

function requireIdentifier(label: string, value: string, pattern: RegExp) {
  const normalized = value.trim().toLowerCase()
  if (!pattern.test(normalized)) throw new Error(`${label} буруу байна.`)
  return normalized
}
