import { and, desc, eq, exists, getTableColumns, isNull, type InferSelectModel, type SQL } from "drizzle-orm"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"
import { z } from "zod"
import { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { paymentBatchGuard } from "./payment-ledger"
import { sha256Hex, stableJson } from "./payment-provider"
import {
  FinanceCostBases,
  FinanceCostCategories,
  FinanceCostDirections,
  FinanceCostEntryTable,
  FinanceCostSourceTypes,
  FinanceCostValuationMethods,
  FinanceCostValuationTable,
  FinanceCurrencies,
  FinanceFxRateTable,
} from "./schema/billing.sql"

const identifier = z.string().trim().min(1).max(30)
const externalIdentifier = z.string().trim().min(1).max(255)
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const payloadHash = z.string().regex(/^[a-f0-9]{64}$/)
const MAX_MNT_AMOUNT = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000)
const USD_MICROCENTS_PER_USD = 100_000_000n

export const RecordFinanceFxRateSchema = z
  .object({
    id: identifier.optional(),
    rateMicromntPerUSD: positiveSafeInteger,
    source: z.string().trim().min(1).max(64),
    sourceReference: externalIdentifier,
    idempotencyKey: externalIdentifier,
    payloadHash,
    effectiveAt: timestamp,
  })
  .strict()

export const RecordFinanceCostEntrySchema = z
  .object({
    id: identifier.optional(),
    workspaceID: identifier,
    category: z.enum(FinanceCostCategories),
    direction: z.enum(FinanceCostDirections),
    basis: z.enum(FinanceCostBases),
    sourceType: z.enum(FinanceCostSourceTypes),
    sourceReference: externalIdentifier,
    usageID: identifier.optional(),
    paymentInvoiceID: identifier.optional(),
    paymentEventID: identifier.optional(),
    provider: externalIdentifier.optional(),
    model: externalIdentifier.optional(),
    originalAmount: positiveSafeInteger,
    originalCurrency: z.enum(FinanceCurrencies),
    fxRateID: identifier.optional(),
    idempotencyKey: externalIdentifier,
    payloadHash,
    effectiveAt: timestamp,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.originalCurrency === "MNT" && input.originalAmount > MAX_MNT_AMOUNT) {
      context.addIssue({
        code: "custom",
        path: ["originalAmount"],
        message: "MNT дүн аюулгүй micro-MNT хязгаараас хэтэрлээ",
      })
    }
    if (input.originalCurrency === "MNT" && input.fxRateID) {
      context.addIssue({
        code: "custom",
        path: ["fxRateID"],
        message: "MNT зардлын бүртгэл FX ханш заах боломжгүй",
      })
    }
    if (input.sourceType === "usage") {
      if (!input.usageID || input.sourceReference !== input.usageID) {
        context.addIssue({
          code: "custom",
          path: ["usageID"],
          message: "Хэрэглээний зардлын бүртгэлд тохирох хэрэглээний эх сурвалжийн лавлагаа шаардлагатай",
        })
      }
      if (input.category !== "model_cost" || !input.provider || !input.model) {
        context.addIssue({
          code: "custom",
          path: ["category"],
          message: "Хэрэглээний зардлын бүртгэлд загварын зардал, нийлүүлэгч, загвар шаардлагатай",
        })
      }
    }
    if (input.sourceType === "payment_settlement" && !input.paymentInvoiceID && !input.paymentEventID) {
      context.addIssue({
        code: "custom",
        path: ["paymentInvoiceID"],
        message: "Төлбөрийн тооцооны зардал нэхэмжлэх эсвэл төлбөрийн үйл явдалтай байх ёстой",
      })
    }
    if (input.category === "model_cost" && !input.provider) {
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Загварын зардалд нийлүүлэгч шаардлагатай",
      })
    }
  })

export const RecordFinanceCostValuationSchema = z
  .object({
    id: identifier.optional(),
    costEntryID: identifier,
    fxRateID: identifier,
    method: z.enum(FinanceCostValuationMethods),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    idempotencyKey: externalIdentifier,
    payloadHash,
  })
  .strict()

export type RecordFinanceFxRateInput = z.input<typeof RecordFinanceFxRateSchema>
export type RecordFinanceCostEntryInput = z.input<typeof RecordFinanceCostEntrySchema>
export type RecordFinanceCostValuationInput = z.input<typeof RecordFinanceCostValuationSchema>

export async function recordFinanceFxRateWithDb(db: Database.TxOrDb, input: RecordFinanceFxRateInput) {
  const rate = RecordFinanceFxRateSchema.parse(input)
  const inserted = await db.insert(FinanceFxRateTable).values(financeFxRateValues(rate)).onConflictDoNothing()

  const stored = await findFxRate(db, rate)
  if (!stored) throw new Error("Санхүүгийн FX ханшийн давхцлын зөрчил гарлаа")
  assertFxRateReplay(stored, rate)
  return {
    kind: resultChanges(inserted) === 0 ? ("duplicate" as const) : ("created" as const),
    rate: stored,
  }
}

export async function recordFinanceFxRate(
  input: RecordFinanceFxRateInput,
  dependencies: { batch?: typeof Database.batch } = {},
) {
  const rate = RecordFinanceFxRateSchema.parse(input)
  const { id, ...values } = financeFxRateValues(rate)
  const [inserted, stored] = await (dependencies.batch ?? Database.batch)((db) => [
    db
      .insert(FinanceFxRateTable)
      .values({ id, ...values })
      .onConflictDoNothing(),
    db.select().from(FinanceFxRateTable).where(eq(FinanceFxRateTable.idempotency_key, rate.idempotencyKey)),
    paymentBatchGuard(
      db,
      exists(db.select().from(FinanceFxRateTable).where(financeRowMatches(FinanceFxRateTable, values))),
    ),
  ])
  return { kind: resultChanges(inserted) === 0 ? ("duplicate" as const) : ("created" as const), rate: stored[0]! }
}

function financeFxRateValues(rate: z.infer<typeof RecordFinanceFxRateSchema>) {
  return {
    id: rate.id ?? Identifier.create("financeFxRate"),
    base_currency: "USD" as const,
    quote_currency: "MNT" as const,
    rate_micromnt_per_usd: rate.rateMicromntPerUSD,
    source: rate.source,
    source_reference: rate.sourceReference,
    idempotency_key: rate.idempotencyKey,
    payload_hash: rate.payloadHash,
    time_effective: new Date(rate.effectiveAt),
  }
}

export async function recordFinanceCostEntryWithDb(db: Database.TxOrDb, input: RecordFinanceCostEntryInput) {
  const entry = RecordFinanceCostEntrySchema.parse(input)
  const valuation = await resolveMntValuation(db, entry)
  const inserted = await db
    .insert(FinanceCostEntryTable)
    .values(financeCostEntryValues(entry, valuation))
    .onConflictDoNothing()

  const stored = await findCostEntry(db, entry)
  if (!stored) throw new Error("Санхүүгийн зардлын бүртгэлийн давхцлын зөрчил гарлаа")
  assertCostEntryReplay(stored, entry, valuation)
  return {
    kind: resultChanges(inserted) === 0 ? ("duplicate" as const) : ("created" as const),
    entry: stored,
  }
}

export function financeCostEntryValues(entry: z.infer<typeof RecordFinanceCostEntrySchema>, valuation: number | null) {
  return {
    id: entry.id ?? Identifier.create("financeCost"),
    workspace_id: entry.workspaceID,
    category: entry.category,
    direction: entry.direction,
    basis: entry.basis,
    source_type: entry.sourceType,
    source_reference: entry.sourceReference,
    usage_id: entry.usageID ?? null,
    payment_invoice_id: entry.paymentInvoiceID ?? null,
    payment_event_id: entry.paymentEventID ?? null,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    original_amount: entry.originalAmount,
    original_currency: entry.originalCurrency,
    fx_rate_id: entry.fxRateID ?? null,
    amount_mnt_micros: valuation,
    idempotency_key: entry.idempotencyKey,
    payload_hash: entry.payloadHash,
    time_effective: new Date(entry.effectiveAt),
  }
}

export async function recordFinanceCostEntry(
  input: RecordFinanceCostEntryInput,
  dependencies: { batch?: typeof Database.batch } = {},
) {
  const entry = RecordFinanceCostEntrySchema.parse(input)
  const batch = dependencies.batch ?? Database.batch
  const rate = entry.fxRateID
    ? (
        await batch((db) => [db.select().from(FinanceFxRateTable).where(eq(FinanceFxRateTable.id, entry.fxRateID!))])
      )[0][0]
    : undefined
  const valuation = resolveMntValuationFromRate(entry, rate)
  const { id, ...values } = financeCostEntryValues(entry, valuation)
  const [inserted, stored] = await batch((db) => [
    db
      .insert(FinanceCostEntryTable)
      .values({ id, ...values })
      .onConflictDoNothing(),
    db.select().from(FinanceCostEntryTable).where(eq(FinanceCostEntryTable.idempotency_key, entry.idempotencyKey)),
    paymentBatchGuard(
      db,
      exists(db.select().from(FinanceCostEntryTable).where(financeRowMatches(FinanceCostEntryTable, values))),
    ),
    ...(rate
      ? [
          paymentBatchGuard(
            db,
            exists(db.select().from(FinanceFxRateTable).where(financeRowMatches(FinanceFxRateTable, rate))),
          ),
        ]
      : []),
  ])
  return { kind: resultChanges(inserted) === 0 ? ("duplicate" as const) : ("created" as const), entry: stored[0]! }
}

export async function recordFinanceCostValuationWithDb(db: Database.TxOrDb, input: RecordFinanceCostValuationInput) {
  const valuation = RecordFinanceCostValuationSchema.parse(input)
  const costEntry = await db
    .select()
    .from(FinanceCostEntryTable)
    .where(eq(FinanceCostEntryTable.id, valuation.costEntryID))
    .then((rows) => rows[0])
  const rate = await db
    .select()
    .from(FinanceFxRateTable)
    .where(eq(FinanceFxRateTable.id, valuation.fxRateID))
    .then((rows) => rows[0])
  const amountMntMicros = costValuationAmount(costEntry, rate)
  const stored = await findCostValuation(db, valuation)
  if (stored) {
    assertCostValuationReplay(stored, valuation, amountMntMicros)
    return { kind: "duplicate" as const, valuation: stored }
  }

  const latest = await db
    .select({ version: FinanceCostValuationTable.version })
    .from(FinanceCostValuationTable)
    .where(eq(FinanceCostValuationTable.cost_entry_id, valuation.costEntryID))
    .orderBy(desc(FinanceCostValuationTable.version))
    .limit(1)
    .then((rows) => rows[0])
  const expectedVersion = (latest?.version ?? 0) + 1
  if (valuation.version !== expectedVersion) {
    throw new Error(`Санхүүгийн зардлын үнэлгээний хувилбар ${expectedVersion} байх ёстой`)
  }

  const inserted = await db
    .insert(FinanceCostValuationTable)
    .values(financeCostValuationValues(valuation, amountMntMicros))
    .onConflictDoNothing()

  const recorded = await findCostValuation(db, valuation)
  if (!recorded) throw new Error("Санхүүгийн зардлын үнэлгээний давхцлын зөрчил гарлаа")
  assertCostValuationReplay(recorded, valuation, amountMntMicros)
  return {
    kind: resultChanges(inserted) === 0 ? ("duplicate" as const) : ("created" as const),
    valuation: recorded,
  }
}

export async function recordFinanceCostValuation(
  input: RecordFinanceCostValuationInput,
  dependencies: { batch?: typeof Database.batch } = {},
) {
  const valuation = RecordFinanceCostValuationSchema.parse(input)
  const batch = dependencies.batch ?? Database.batch
  const [costs, rates, previous, latest] = await batch((db) => [
    db.select().from(FinanceCostEntryTable).where(eq(FinanceCostEntryTable.id, valuation.costEntryID)),
    db.select().from(FinanceFxRateTable).where(eq(FinanceFxRateTable.id, valuation.fxRateID)),
    db
      .select()
      .from(FinanceCostValuationTable)
      .where(eq(FinanceCostValuationTable.idempotency_key, valuation.idempotencyKey)),
    db
      .select({ version: FinanceCostValuationTable.version })
      .from(FinanceCostValuationTable)
      .where(eq(FinanceCostValuationTable.cost_entry_id, valuation.costEntryID))
      .orderBy(desc(FinanceCostValuationTable.version))
      .limit(1),
  ])
  const amount = costValuationAmount(costs[0], rates[0])
  if (previous[0]) assertCostValuationReplay(previous[0], valuation, amount)
  if (!previous[0] && valuation.version !== (latest[0]?.version ?? 0) + 1) {
    throw new Error(`Санхүүгийн зардлын үнэлгээний хувилбар ${(latest[0]?.version ?? 0) + 1} байх ёстой`)
  }
  const { id, ...values } = financeCostValuationValues(valuation, amount)
  // D1's existing insert trigger enforces sequential versions inside this atomic batch.
  const [inserted, stored] = await batch((db) => [
    db
      .insert(FinanceCostValuationTable)
      .values({ id, ...values })
      .onConflictDoNothing(),
    db
      .select()
      .from(FinanceCostValuationTable)
      .where(eq(FinanceCostValuationTable.idempotency_key, valuation.idempotencyKey)),
    paymentBatchGuard(
      db,
      exists(db.select().from(FinanceCostValuationTable).where(financeRowMatches(FinanceCostValuationTable, values))),
    ),
    paymentBatchGuard(
      db,
      exists(db.select().from(FinanceCostEntryTable).where(financeRowMatches(FinanceCostEntryTable, costs[0]!))),
    ),
    paymentBatchGuard(
      db,
      exists(db.select().from(FinanceFxRateTable).where(financeRowMatches(FinanceFxRateTable, rates[0]!))),
    ),
  ])
  return { kind: resultChanges(inserted) === 0 ? ("duplicate" as const) : ("created" as const), valuation: stored[0]! }
}

function financeCostValuationValues(valuation: z.infer<typeof RecordFinanceCostValuationSchema>, amount: number) {
  return {
    id: valuation.id ?? Identifier.create("financeCostValuation"),
    cost_entry_id: valuation.costEntryID,
    fx_rate_id: valuation.fxRateID,
    method: valuation.method,
    version: valuation.version,
    amount_mnt_micros: amount,
    idempotency_key: valuation.idempotencyKey,
    payload_hash: valuation.payloadHash,
  }
}

function costValuationAmount(
  cost: typeof FinanceCostEntryTable.$inferSelect | undefined,
  rate: typeof FinanceFxRateTable.$inferSelect | undefined,
) {
  if (!cost) throw new Error("Санхүүгийн зардлын үнэлгээ байхгүй зардлын бүртгэл зааж байна")
  if (cost.original_currency !== "USD" || cost.fx_rate_id !== null || cost.amount_mnt_micros !== null) {
    throw new Error("Санхүүгийн зардлын үнэлгээнд үнэлэгдээгүй USD зардлын бүртгэл шаардлагатай")
  }
  if (!rate) throw new Error("Санхүүгийн зардлын үнэлгээ байхгүй FX ханшийг зааж байна")
  if (rate.base_currency !== "USD" || rate.quote_currency !== "MNT") {
    throw new Error("Санхүүгийн зардлын үнэлгээ үл тохирох FX ханшийг зааж байна")
  }
  return valueUsdInMntMicros(cost.original_amount, rate.rate_micromnt_per_usd)
}

export function financeRowMatches<T extends SQLiteTable>(table: T, values: Partial<InferSelectModel<T>>): SQL {
  const columns = getTableColumns(table)
  return and(
    ...Object.entries(values).map(([key, value]) => (value == null ? isNull(columns[key]) : eq(columns[key], value))),
  )!
}

const EstimatedModelCostSchema = z
  .object({
    workspaceID: identifier,
    usageID: identifier,
    provider: externalIdentifier,
    model: externalIdentifier,
    costUSDInMicrocents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    effectiveAt: timestamp,
    plan: z.enum(["basic", "pro", "max", "byok", "legacy-lite", "balance"]).optional(),
  })
  .strict()

export async function recordEstimatedModelCostWithDb(
  db: Database.TxOrDb,
  input: z.input<typeof EstimatedModelCostSchema>,
) {
  const entry = await prepareEstimatedModelCost(input)
  if (!entry) return { kind: "skipped" as const }
  return recordFinanceCostEntryWithDb(db, entry)
}

export async function prepareEstimatedModelCost(input: z.input<typeof EstimatedModelCostSchema>) {
  const cost = EstimatedModelCostSchema.parse(input)
  if (cost.plan === "byok" || cost.costUSDInMicrocents === 0) return undefined

  const payload = {
    version: 1,
    workspaceID: cost.workspaceID,
    usageID: cost.usageID,
    provider: cost.provider,
    model: cost.model,
    costUSDInMicrocents: cost.costUSDInMicrocents,
    effectiveAt: cost.effectiveAt,
  }
  return RecordFinanceCostEntrySchema.parse({
    workspaceID: cost.workspaceID,
    category: "model_cost",
    direction: "debit",
    basis: "estimated",
    sourceType: "usage",
    sourceReference: cost.usageID,
    usageID: cost.usageID,
    provider: cost.provider,
    model: cost.model,
    originalAmount: cost.costUSDInMicrocents,
    originalCurrency: "USD",
    idempotencyKey: `usage:${cost.usageID}:model-cost:estimated`,
    payloadHash: await sha256Hex(stableJson(payload)),
    effectiveAt: cost.effectiveAt,
  })
}

async function resolveMntValuation(db: Database.TxOrDb, entry: z.infer<typeof RecordFinanceCostEntrySchema>) {
  const rate = entry.fxRateID
    ? await db
        .select()
        .from(FinanceFxRateTable)
        .where(eq(FinanceFxRateTable.id, entry.fxRateID))
        .then((rows) => rows[0])
    : undefined
  return resolveMntValuationFromRate(entry, rate)
}

function resolveMntValuationFromRate(
  entry: z.infer<typeof RecordFinanceCostEntrySchema>,
  rate: typeof FinanceFxRateTable.$inferSelect | undefined,
) {
  if (entry.originalCurrency === "MNT") return safeNumber(BigInt(entry.originalAmount) * 1_000_000n)
  if (!entry.fxRateID) return null
  if (!rate) throw new Error("Санхүүгийн зардлын бүртгэл байхгүй FX ханшийг зааж байна")
  if (rate.base_currency !== "USD" || rate.quote_currency !== "MNT") {
    throw new Error("Санхүүгийн зардлын бүртгэл үл тохирох FX ханшийг зааж байна")
  }
  return valueUsdInMntMicros(entry.originalAmount, rate.rate_micromnt_per_usd)
}

async function findFxRate(db: Database.TxOrDb, input: z.infer<typeof RecordFinanceFxRateSchema>) {
  const byKey = await db
    .select()
    .from(FinanceFxRateTable)
    .where(eq(FinanceFxRateTable.idempotency_key, input.idempotencyKey))
    .then((rows) => rows[0])
  if (byKey) return byKey
  return db
    .select()
    .from(FinanceFxRateTable)
    .where(
      and(eq(FinanceFxRateTable.source, input.source), eq(FinanceFxRateTable.source_reference, input.sourceReference)),
    )
    .then((rows) => rows[0])
}

async function findCostEntry(db: Database.TxOrDb, input: z.infer<typeof RecordFinanceCostEntrySchema>) {
  const byKey = await db
    .select()
    .from(FinanceCostEntryTable)
    .where(eq(FinanceCostEntryTable.idempotency_key, input.idempotencyKey))
    .then((rows) => rows[0])
  if (byKey) return byKey
  return db
    .select()
    .from(FinanceCostEntryTable)
    .where(
      and(
        eq(FinanceCostEntryTable.source_type, input.sourceType),
        eq(FinanceCostEntryTable.source_reference, input.sourceReference),
        eq(FinanceCostEntryTable.category, input.category),
        eq(FinanceCostEntryTable.direction, input.direction),
        eq(FinanceCostEntryTable.basis, input.basis),
      ),
    )
    .then((rows) => rows[0])
}

async function findCostValuation(db: Database.TxOrDb, input: z.infer<typeof RecordFinanceCostValuationSchema>) {
  const byKey = await db
    .select()
    .from(FinanceCostValuationTable)
    .where(eq(FinanceCostValuationTable.idempotency_key, input.idempotencyKey))
    .then((rows) => rows[0])
  if (byKey) return byKey
  return db
    .select()
    .from(FinanceCostValuationTable)
    .where(
      and(
        eq(FinanceCostValuationTable.cost_entry_id, input.costEntryID),
        eq(FinanceCostValuationTable.version, input.version),
      ),
    )
    .then((rows) => rows[0])
}

function assertFxRateReplay(
  stored: typeof FinanceFxRateTable.$inferSelect,
  replay: z.infer<typeof RecordFinanceFxRateSchema>,
) {
  if (
    stored.rate_micromnt_per_usd !== replay.rateMicromntPerUSD ||
    stored.source !== replay.source ||
    stored.source_reference !== replay.sourceReference ||
    stored.idempotency_key !== replay.idempotencyKey ||
    stored.payload_hash !== replay.payloadHash ||
    stored.time_effective.getTime() !== replay.effectiveAt
  ) {
    throw new Error("Санхүүгийн FX ханшийг дахин боловсруулахад хадгалсан ханштай зөрчилдлөө")
  }
}

function assertCostEntryReplay(
  stored: typeof FinanceCostEntryTable.$inferSelect,
  replay: z.infer<typeof RecordFinanceCostEntrySchema>,
  valuation: number | null,
) {
  if (
    stored.workspace_id !== replay.workspaceID ||
    stored.category !== replay.category ||
    stored.direction !== replay.direction ||
    stored.basis !== replay.basis ||
    stored.source_type !== replay.sourceType ||
    stored.source_reference !== replay.sourceReference ||
    stored.usage_id !== (replay.usageID ?? null) ||
    stored.payment_invoice_id !== (replay.paymentInvoiceID ?? null) ||
    stored.payment_event_id !== (replay.paymentEventID ?? null) ||
    stored.provider !== (replay.provider ?? null) ||
    stored.model !== (replay.model ?? null) ||
    stored.original_amount !== replay.originalAmount ||
    stored.original_currency !== replay.originalCurrency ||
    stored.fx_rate_id !== (replay.fxRateID ?? null) ||
    stored.amount_mnt_micros !== valuation ||
    stored.idempotency_key !== replay.idempotencyKey ||
    stored.payload_hash !== replay.payloadHash ||
    stored.time_effective.getTime() !== replay.effectiveAt
  ) {
    throw new Error("Санхүүгийн зардлын бүртгэлийг дахин тоглуулахад хадгалсан бүртгэлтэй зөрчилдлөө")
  }
}

function assertCostValuationReplay(
  stored: typeof FinanceCostValuationTable.$inferSelect,
  replay: z.infer<typeof RecordFinanceCostValuationSchema>,
  amountMntMicros: number,
) {
  if (
    stored.cost_entry_id !== replay.costEntryID ||
    stored.fx_rate_id !== replay.fxRateID ||
    stored.method !== replay.method ||
    stored.version !== replay.version ||
    stored.amount_mnt_micros !== amountMntMicros ||
    stored.idempotency_key !== replay.idempotencyKey ||
    stored.payload_hash !== replay.payloadHash
  ) {
    throw new Error("Санхүүгийн зардлын үнэлгээг дахин тоглуулахад хадгалсан үнэлгээтэй зөрчилдлөө")
  }
}

function valueUsdInMntMicros(amountMicrocents: number, rateMicromntPerUSD: number) {
  const numerator = BigInt(amountMicrocents) * BigInt(rateMicromntPerUSD)
  return safeNumber((numerator + USD_MICROCENTS_PER_USD / 2n) / USD_MICROCENTS_PER_USD)
}

function safeNumber(value: bigint) {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Санхүүгийн MNT үнэлгээ аюулгүй бүхэл тооны хязгаараас хэтэрлээ")
  }
  return Number(value)
}

function resultChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0
  if ("meta" in result && result.meta && typeof result.meta === "object" && "changes" in result.meta) {
    return Number(result.meta.changes ?? 0)
  }
  if ("changes" in result) return Number(result.changes ?? 0)
  return 0
}
