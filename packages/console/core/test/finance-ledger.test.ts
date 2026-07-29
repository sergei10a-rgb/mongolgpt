import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import type { Database } from "../src/drizzle"
import {
  recordEstimatedModelCostWithDb,
  recordFinanceCostEntryWithDb,
  recordFinanceCostValuationWithDb,
  recordFinanceFxRateWithDb,
} from "../src/finance-ledger"
import * as schema from "../src/schema-d1"

// oxlint-disable typescript-eslint/await-thenable -- Bun's async expect matchers are thenable at runtime.

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

const hash = (character: string) => character.repeat(64)
const effectiveAt = Date.UTC(2026, 6, 29, 12)

describe("immutable finance ledger", () => {
  async function fixture() {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Test drivers share this schema contract.
    const db = drizzleDb as unknown as Database.TxOrDb
    sqlite.query("insert into workspace (id, name) values (?, ?)").run("wrk_finance", "Finance test")
    return { sqlite, db }
  }

  test("records an exact historical FX rate once and rejects conflicting replay", async () => {
    const { sqlite, db } = await fixture()
    const rate = {
      id: "fxr_finance_test",
      rateMicromntPerUSD: 3_450_123_456,
      source: "mongolbank",
      sourceReference: "2026-07-29:USD",
      idempotencyKey: "fx:mongolbank:2026-07-29:USD",
      payloadHash: hash("a"),
      effectiveAt,
    }

    await expect(recordFinanceFxRateWithDb(db, rate)).resolves.toMatchObject({ kind: "created" })
    await expect(recordFinanceFxRateWithDb(db, rate)).resolves.toMatchObject({ kind: "duplicate" })
    await expect(recordFinanceFxRateWithDb(db, { ...rate, rateMicromntPerUSD: 3_500_000_000 })).rejects.toThrow(
      "Finance FX rate replay conflicts",
    )
    expect(sqlite.query("select count(*) as count from finance_fx_rate").get()).toEqual({ count: 1 })
  })

  test("values MNT exactly and USD with the referenced historical FX rate", async () => {
    const { sqlite, db } = await fixture()
    await recordFinanceFxRateWithDb(db, {
      id: "fxr_finance_value",
      rateMicromntPerUSD: 3_450_123_456,
      source: "mongolbank",
      sourceReference: "2026-07-29:USD",
      idempotencyKey: "fx:mongolbank:2026-07-29:USD",
      payloadHash: hash("b"),
      effectiveAt,
    })

    await recordFinanceCostEntryWithDb(db, {
      id: "fce_payment_fee",
      workspaceID: "wrk_finance",
      category: "payment_fee",
      direction: "debit",
      basis: "actual",
      sourceType: "manual",
      sourceReference: "fee:1",
      provider: "qpay",
      originalAmount: 250,
      originalCurrency: "MNT",
      idempotencyKey: "fee:1",
      payloadHash: hash("c"),
      effectiveAt,
    })
    await recordFinanceCostEntryWithDb(db, {
      id: "fce_model_actual",
      workspaceID: "wrk_finance",
      category: "model_cost",
      direction: "debit",
      basis: "actual",
      sourceType: "provider_statement",
      sourceReference: "openrouter:line:1",
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
      originalAmount: 150_000_000,
      originalCurrency: "USD",
      fxRateID: "fxr_finance_value",
      idempotencyKey: "openrouter:line:1:model-cost",
      payloadHash: hash("d"),
      effectiveAt,
    })

    expect(
      sqlite.query("select id, original_currency, amount_mnt_micros from finance_cost_entry order by id").all(),
    ).toEqual([
      { id: "fce_model_actual", original_currency: "USD", amount_mnt_micros: 5_175_185_184 },
      { id: "fce_payment_fee", original_currency: "MNT", amount_mnt_micros: 250_000_000 },
    ])
  })

  test("keeps unvalued USD cost immutable until an explicit valued entry is available", async () => {
    const { sqlite, db } = await fixture()
    const entry = {
      id: "fce_unvalued",
      workspaceID: "wrk_finance",
      category: "model_cost" as const,
      direction: "debit" as const,
      basis: "estimated" as const,
      sourceType: "provider_statement" as const,
      sourceReference: "nvidia:statement:1",
      provider: "nvidia",
      model: "meta/llama",
      originalAmount: 25_000_000,
      originalCurrency: "USD" as const,
      idempotencyKey: "nvidia:statement:1:model-cost",
      payloadHash: hash("e"),
      effectiveAt,
    }

    await expect(recordFinanceCostEntryWithDb(db, entry)).resolves.toMatchObject({ kind: "created" })
    await expect(recordFinanceCostEntryWithDb(db, entry)).resolves.toMatchObject({ kind: "duplicate" })
    await expect(recordFinanceCostEntryWithDb(db, { ...entry, originalAmount: 26 })).rejects.toThrow(
      "Finance cost entry replay conflicts",
    )
    expect(
      sqlite.query("select fx_rate_id, amount_mnt_micros from finance_cost_entry where id = ?").get(entry.id),
    ).toEqual({ fx_rate_id: null, amount_mnt_micros: null })

    await recordFinanceFxRateWithDb(db, {
      id: "fxr_unvalued_v1",
      rateMicromntPerUSD: 3_450_123_456,
      source: "mongolbank",
      sourceReference: "2026-07-29:USD",
      idempotencyKey: "fx:mongolbank:2026-07-29:USD",
      payloadHash: hash("3"),
      effectiveAt,
    })
    const valuation = {
      id: "fvl_unvalued_v1",
      costEntryID: entry.id,
      fxRateID: "fxr_unvalued_v1",
      method: "historical_spot" as const,
      version: 1,
      idempotencyKey: "valuation:nvidia:statement:1:v1",
      payloadHash: hash("4"),
    }
    await expect(recordFinanceCostValuationWithDb(db, valuation)).resolves.toMatchObject({ kind: "created" })
    await expect(recordFinanceCostValuationWithDb(db, valuation)).resolves.toMatchObject({ kind: "duplicate" })
    await expect(recordFinanceCostValuationWithDb(db, { ...valuation, method: "manual" })).rejects.toThrow(
      "Finance cost valuation replay conflicts",
    )

    await recordFinanceFxRateWithDb(db, {
      id: "fxr_unvalued_v2",
      rateMicromntPerUSD: 3_500_000_000,
      source: "provider_settlement",
      sourceReference: "nvidia:statement:1:USD",
      idempotencyKey: "fx:nvidia:statement:1:USD",
      payloadHash: hash("5"),
      effectiveAt,
    })
    const correction = {
      id: "fvl_unvalued_v2",
      costEntryID: entry.id,
      fxRateID: "fxr_unvalued_v2",
      method: "provider_settlement" as const,
      version: 2,
      idempotencyKey: "valuation:nvidia:statement:1:v2",
      payloadHash: hash("6"),
    }
    await expect(recordFinanceCostValuationWithDb(db, { ...correction, version: 3 })).rejects.toThrow(
      "Finance cost valuation version must be 2",
    )
    await expect(recordFinanceCostValuationWithDb(db, correction)).resolves.toMatchObject({ kind: "created" })

    expect(
      sqlite
        .query("select fx_rate_id, method, version, amount_mnt_micros from finance_cost_valuation order by version")
        .all(),
    ).toEqual([
      {
        fx_rate_id: "fxr_unvalued_v1",
        method: "historical_spot",
        version: 1,
        amount_mnt_micros: 862_530_864,
      },
      {
        fx_rate_id: "fxr_unvalued_v2",
        method: "provider_settlement",
        version: 2,
        amount_mnt_micros: 875_000_000,
      },
    ])
    expect(
      sqlite.query("select fx_rate_id, amount_mnt_micros from finance_cost_entry where id = ?").get(entry.id),
    ).toEqual({ fx_rate_id: null, amount_mnt_micros: null })
  })

  test("rejects missing FX references and unsafe MNT values", async () => {
    const { db } = await fixture()
    const base = {
      workspaceID: "wrk_finance",
      category: "model_cost" as const,
      direction: "debit" as const,
      basis: "actual" as const,
      sourceType: "provider_statement" as const,
      sourceReference: "provider:missing-fx",
      provider: "openrouter",
      model: "openai/gpt",
      originalAmount: 100,
      originalCurrency: "USD" as const,
      fxRateID: "fxr_missing",
      idempotencyKey: "provider:missing-fx:model-cost",
      payloadHash: hash("f"),
      effectiveAt,
    }

    await expect(recordFinanceCostEntryWithDb(db, base)).rejects.toThrow("missing FX rate")
    await expect(
      recordFinanceCostEntryWithDb(db, {
        ...base,
        sourceReference: "manual:too-large",
        sourceType: "manual",
        category: "payment_fee",
        originalAmount: Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000) + 1,
        originalCurrency: "MNT",
        fxRateID: undefined,
        idempotencyKey: "manual:too-large",
      }),
    ).rejects.toThrow("safe micro-MNT range")
  })

  test("does not charge MongolGPT for BYOK or zero-cost usage", async () => {
    const { sqlite, db } = await fixture()
    const base = {
      workspaceID: "wrk_finance",
      usageID: "usg_finance_byok",
      provider: "openrouter",
      model: "free-model",
      costUSDInMicrocents: 500,
      effectiveAt,
    }

    await expect(recordEstimatedModelCostWithDb(db, { ...base, plan: "byok" })).resolves.toEqual({
      kind: "skipped",
    })
    await expect(
      recordEstimatedModelCostWithDb(db, {
        ...base,
        usageID: "usg_finance_free",
        costUSDInMicrocents: 0,
        plan: "basic",
      }),
    ).resolves.toEqual({ kind: "skipped" })
    expect(sqlite.query("select count(*) as count from finance_cost_entry").get()).toEqual({ count: 0 })
  })

  test("prevents updates and deletes at the database boundary", async () => {
    const { sqlite, db } = await fixture()
    await recordFinanceFxRateWithDb(db, {
      id: "fxr_immutable",
      rateMicromntPerUSD: 3_400_000_000,
      source: "mongolbank",
      sourceReference: "2026-07-30:USD",
      idempotencyKey: "fx:mongolbank:2026-07-30:USD",
      payloadHash: hash("1"),
      effectiveAt,
    })
    await recordFinanceCostEntryWithDb(db, {
      id: "fce_immutable",
      workspaceID: "wrk_finance",
      category: "payment_fee",
      direction: "debit",
      basis: "actual",
      sourceType: "manual",
      sourceReference: "immutable:fee",
      provider: "bonum",
      originalAmount: 100,
      originalCurrency: "MNT",
      idempotencyKey: "immutable:fee",
      payloadHash: hash("2"),
      effectiveAt,
    })
    await recordFinanceCostEntryWithDb(db, {
      id: "fce_immutable_usd",
      workspaceID: "wrk_finance",
      category: "model_cost",
      direction: "debit",
      basis: "actual",
      sourceType: "provider_statement",
      sourceReference: "immutable:model-cost",
      provider: "openrouter",
      model: "openai/gpt",
      originalAmount: 100_000_000,
      originalCurrency: "USD",
      idempotencyKey: "immutable:model-cost",
      payloadHash: hash("7"),
      effectiveAt,
    })
    await recordFinanceCostValuationWithDb(db, {
      id: "fvl_immutable",
      costEntryID: "fce_immutable_usd",
      fxRateID: "fxr_immutable",
      method: "historical_spot",
      version: 1,
      idempotencyKey: "immutable:model-cost:valuation",
      payloadHash: hash("8"),
    })

    expect(() =>
      sqlite.query("update finance_fx_rate set rate_micromnt_per_usd = ? where id = ?").run(1, "fxr_immutable"),
    ).toThrow("finance_fx_rate is immutable")
    expect(() => sqlite.query("delete from finance_fx_rate where id = ?").run("fxr_immutable")).toThrow(
      "finance_fx_rate is immutable",
    )
    expect(() =>
      sqlite.query("update finance_cost_entry set original_amount = ? where id = ?").run(1, "fce_immutable"),
    ).toThrow("finance_cost_entry is immutable")
    expect(() => sqlite.query("delete from finance_cost_entry where id = ?").run("fce_immutable")).toThrow(
      "finance_cost_entry is immutable",
    )
    expect(() =>
      sqlite.query("update finance_cost_valuation set amount_mnt_micros = ? where id = ?").run(1, "fvl_immutable"),
    ).toThrow("finance_cost_valuation is immutable")
    expect(() => sqlite.query("delete from finance_cost_valuation where id = ?").run("fvl_immutable")).toThrow(
      "finance_cost_valuation is immutable",
    )
    expect(() =>
      sqlite
        .query(
          `insert into finance_cost_valuation
            (id, cost_entry_id, fx_rate_id, method, version, amount_mnt_micros, idempotency_key, payload_hash)
           values (?, ?, ?, 'manual', 1, 1, ?, ?)`,
        )
        .run("fvl_orphan", "fce_missing", "fxr_immutable", "orphan:valuation", hash("9")),
    ).toThrow("finance_cost_valuation requires an unvalued USD cost entry")
  })
})
