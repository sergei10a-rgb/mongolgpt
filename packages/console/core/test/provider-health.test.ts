import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { Identifier } from "../src/identifier"
import {
  persistProviderAttemptWithDb,
  ProviderAttemptEventSchema,
  pruneProviderAttemptsWithDb,
  PROVIDER_ATTEMPT_RETENTION_MS,
  type ProviderAttemptEvent,
} from "../src/provider-health"
import * as schema from "../src/schema-d1"

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

function event(overrides: Partial<ProviderAttemptEvent> = {}): ProviderAttemptEvent {
  return {
    type: "provider-attempt",
    version: 1,
    id: Identifier.create("providerAttempt"),
    provider: "openrouter-free",
    providerKind: "openrouter",
    usageMode: "managed",
    model: "free-auto",
    outcome: "success",
    responseStatus: 200,
    latencyMs: 240,
    retryCount: 0,
    fallback: false,
    timeCreated: Date.UTC(2026, 7, 30, 12),
    ...overrides,
  }
}

async function fixture() {
  const sqlite = new SQLite(":memory:")
  sqlite.exec(await migrationSql())
  const db: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
  return { sqlite, db: db as unknown as Parameters<typeof persistProviderAttemptWithDb>[0] }
}

describe("managed provider health telemetry", () => {
  test("accepts only bounded managed or trial attempt evidence with coherent outcomes", () => {
    expect(ProviderAttemptEventSchema.safeParse(event()).success).toBe(true)
    expect(
      ProviderAttemptEventSchema.safeParse(
        event({ outcome: "transient-error", responseStatus: 429, retryCount: 1, fallback: true }),
      ).success,
    ).toBe(true)
    expect(ProviderAttemptEventSchema.safeParse(event({ usageMode: "byok" as "managed" })).success).toBe(false)
    expect(ProviderAttemptEventSchema.safeParse(event({ outcome: "success", responseStatus: 201 })).success).toBe(false)
    expect(
      ProviderAttemptEventSchema.safeParse(event({ outcome: "permanent-error", responseStatus: 503 })).success,
    ).toBe(false)
    expect(
      ProviderAttemptEventSchema.safeParse(
        event({ outcome: "permanent-error", responseStatus: 401, provider: "x".repeat(256) }),
      ).success,
    ).toBe(false)
  })

  test("persists an attempt exactly once and rejects a conflicting replay", async () => {
    const { sqlite, db } = await fixture()
    const input = event()
    expect(await persistProviderAttemptWithDb(db, input)).toBe("inserted")
    expect(await persistProviderAttemptWithDb(db, input)).toBe("duplicate")
    expect(sqlite.query("select count(*) as count from provider_attempt").get()).toEqual({ count: 1 })
    await expect(persistProviderAttemptWithDb(db, { ...input, latencyMs: input.latencyMs + 1 })).rejects.toThrow(
      "давхардлын зөрчил",
    )
  })

  test("deletes only telemetry older than the fixed retention window in bounded batches", async () => {
    const { sqlite, db } = await fixture()
    const now = Date.UTC(2026, 7, 30, 12)
    await persistProviderAttemptWithDb(db, event({ timeCreated: now - PROVIDER_ATTEMPT_RETENTION_MS - 2 }))
    await persistProviderAttemptWithDb(db, event({ timeCreated: now - PROVIDER_ATTEMPT_RETENTION_MS - 1 }))
    await persistProviderAttemptWithDb(db, event({ timeCreated: now - PROVIDER_ATTEMPT_RETENTION_MS }))

    expect(await pruneProviderAttemptsWithDb(db, now, { batchSize: 1, maxBatches: 1 })).toMatchObject({
      deleted: 1,
      complete: false,
    })
    expect(await pruneProviderAttemptsWithDb(db, now)).toMatchObject({ deleted: 1, complete: true })
    expect(sqlite.query("select count(*) as count from provider_attempt").get()).toEqual({ count: 1 })
  })
})
