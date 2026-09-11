import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { RecordFinancePaymentSettlementInput } from "../src/finance-settlement"

const native: typeof import("./fixtures/finance-settlement-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-finance-d1-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined
let checks = 0
const now = Date.UTC(2026, 8, 12, 1)

try {
  platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL("./fixtures/payment-checkout-d1.jsonc", import.meta.url)),
    persist: { path: persistTo },
    remoteBindings: false,
    envFiles: [],
  })
  const binding = platform.env.DB
  const db = native.createDatabase(binding)
  const batch: typeof Database.batch = (callback) => db.batch(callback(db))
  const run = (query: string, ...values: (string | number | null)[]) =>
    binding
      .prepare(query)
      .bind(...values)
      .run()
  const row = (query: string, ...values: (string | number | null)[]) =>
    binding
      .prepare(query)
      .bind(...values)
      .first()
  const directory = fileURLToPath(new URL("../migrations-d1/", import.meta.url))
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!(await readdir(join(directory, entry.name))).includes("migration.sql")) continue
    for (const query of unstable_splitSqlQuery(await readFile(join(directory, entry.name, "migration.sql"), "utf8")))
      await binding.prepare(query).run()
  }
  await run("insert into workspace(id,name) values ('wrk_finance','Synthetic finance')")
  const seed = async (id: string, provider: "qpay" | "bonum" = "qpay") => {
    await native.recordPaymentInvoice(
      {
        id: `inv_${id}`,
        workspaceID: "wrk_finance",
        provider,
        merchantAccountID: "synthetic-merchant",
        externalInvoiceID: `invoice-${id}`,
        purpose: "credit",
        amount: 100000,
        currency: "MNT",
      },
      { batch },
    )
    await native.applyPaymentEvent(
      {
        id: `pev_${id}`,
        provider,
        merchantAccountID: "synthetic-merchant",
        externalEventID: `paid-${id}`,
        externalInvoiceID: `invoice-${id}`,
        externalPaymentID: `payment-${id}`,
        type: "paid",
        amount: 100000,
        currency: "MNT",
        payloadHash: "a".repeat(64),
        occurredAt: now,
      },
      undefined,
      { batch },
    )
    return {
      workspaceID: "wrk_finance",
      paymentInvoiceID: `inv_${id}`,
      paymentEventID: `pev_${id}`,
      provider,
      merchantAccountID: "synthetic-merchant",
      externalSettlementID: `statement-${id}`,
      kind: "payment",
      grossAmountMNT: 100000,
      feeAmountMNT: 1000,
      taxAmountMNT: 100,
      netAmountMNT: 98900,
      currency: "MNT",
      idempotencyKey: `settlement-${id}`,
      payloadHash: "b".repeat(64),
      effectiveAt: now,
    } satisfies RecordFinancePaymentSettlementInput
  }
  const record = (input: RecordFinancePaymentSettlementInput, selectedBatch = batch) =>
    native.recordFinancePaymentSettlement(input, { batch: selectedBatch })
  const count = (invoiceID: string) =>
    row(
      "select (select count(*) from finance_payment_settlement where payment_invoice_id=?) settlements, (select count(*) from finance_cost_entry where payment_invoice_id=?) costs",
      invoiceID,
      invoiceID,
    )
  const rollback = (async (callback: Parameters<typeof Database.batch>[0]) => {
    const doomed = db.select({ value: native.sql<number>`json_extract('invalid', '$')` }).from(native.sql`(select 1)`)
    return (await db.batch([...callback(db), doomed])).slice(0, -1)
  }) as typeof Database.batch

  for (const provider of ["qpay", "bonum"] as const) {
    const input = await seed(provider, provider)
    const first = await record(input)
    equal(first.kind, "created")
    equal(first.settlement.net_amount_mnt, 98900)
    equal(
      first.costs.map((cost) => [
        cost.kind,
        cost.entry.category,
        cost.entry.direction,
        cost.entry.basis,
        cost.entry.amount_mnt_micros,
      ]),
      [
        ["created", "payment_fee", "debit", "actual", 1000000000],
        ["created", "tax", "debit", "actual", 100000000],
      ],
    )
    const replay = await record({ ...input, id: "fps_ignored_on_replay" })
    equal(replay.kind, "duplicate")
    equal(replay.settlement.id, first.settlement.id)
    equal(
      replay.costs.map((cost) => cost.kind),
      ["duplicate", "duplicate"],
    )
    equal(await count(input.paymentInvoiceID), { settlements: 1, costs: 2 })
    for (const patch of [
      { feeAmountMNT: 1100, netAmountMNT: 98800 },
      { taxAmountMNT: 200, netAmountMNT: 98800 },
      { payloadHash: "c".repeat(64) },
      { effectiveAt: now + 1 },
      { externalSettlementID: "different" },
      { idempotencyKey: "different" },
      { paymentEventID: undefined },
      { kind: "adjustment" as const },
    ]) {
      await rejects(() => record({ ...input, ...patch }))
      equal(await count(input.paymentInvoiceID), { settlements: 1, costs: 2 })
    }
  }

  const zero = await seed("zero", "bonum")
  equal((await record({ ...zero, feeAmountMNT: 0, taxAmountMNT: 0, netAmountMNT: 100000 })).costs, [])
  equal(await count(zero.paymentInvoiceID), { settlements: 1, costs: 0 })
  const optional = await seed("noevent")
  equal((await record({ ...optional, paymentEventID: undefined })).kind, "created")
  const refund = await seed("refund")
  await native.applyPaymentEvent(
    {
      id: "pev_refunded",
      provider: "qpay",
      merchantAccountID: refund.merchantAccountID,
      externalEventID: "refunded",
      externalInvoiceID: "invoice-refund",
      externalPaymentID: "payment-refund",
      type: "refunded",
      amount: 100000,
      currency: "MNT",
      payloadHash: "c".repeat(64),
      occurredAt: now + 1,
    },
    undefined,
    { batch },
  )
  const credit = await record({
    ...refund,
    paymentEventID: "pev_refunded",
    kind: "refund",
    grossAmountMNT: -100000,
    feeAmountMNT: -1000,
    taxAmountMNT: -100,
    netAmountMNT: -98900,
  })
  equal(
    credit.costs.map((cost) => [cost.entry.direction, cost.entry.original_amount]),
    [
      ["credit", 1000],
      ["credit", 100],
    ],
  )
  const adjustment = await seed("adjustment")
  equal(
    (
      await record({
        ...adjustment,
        kind: "adjustment",
        grossAmountMNT: 500,
        feeAmountMNT: -10,
        taxAmountMNT: 0,
        netAmountMNT: 510,
      })
    ).costs[0]?.entry.direction,
    "credit",
  )

  const rollbackInput = await seed("rollback")
  let writes = 0
  await rejects(() => record(rollbackInput, (callback) => (++writes === 2 ? rollback(callback) : batch(callback))))
  equal(writes, 3)
  equal(await count(rollbackInput.paymentInvoiceID), { settlements: 0, costs: 0 })
  equal((await record(rollbackInput)).kind, "created")

  const taxFailure = await seed("taxfail")
  await run(
    "create trigger synthetic_tax_failure before insert on finance_cost_entry when NEW.payment_invoice_id='inv_taxfail' and NEW.category='tax' begin select raise(ABORT, 'synthetic tax failure'); end",
  )
  await rejects(() => record(taxFailure))
  equal(await count(taxFailure.paymentInvoiceID), { settlements: 0, costs: 0 })
  await run("drop trigger synthetic_tax_failure")
  equal((await record(taxFailure)).costs.length, 2)

  for (const acknowledgements of [1, 2]) {
    const lost = await seed(`lost${acknowledgements}`)
    let calls = 0
    const lose: typeof Database.batch = async (callback) => {
      const result = await batch(callback)
      if (++calls === 2 || (calls === 5 && acknowledgements === 2))
        throw new Error("Synthetic lost commit acknowledgement")
      return result
    }
    if (acknowledgements === 1) equal((await record(lost, lose)).kind, "duplicate")
    else await rejects(() => record(lost, lose))
    equal(await count(lost.paymentInvoiceID), { settlements: 1, costs: 2 })
    equal((await record(lost)).kind, "duplicate")
  }

  const race = await seed("race")
  const barrier = Promise.withResolvers<void>()
  let readers = 0
  const synchronized = () => {
    let calls = 0
    const selected: typeof Database.batch = async (callback) => {
      const result = await batch(callback)
      if (++calls === 1) {
        if (++readers === 6) barrier.resolve()
        await barrier.promise
      }
      return result
    }
    return selected
  }
  const raced = await Promise.all(Array.from({ length: 6 }, () => record(race, synchronized())))
  equal(raced.filter((result) => result.kind === "created").length, 1)
  equal(raced.filter((result) => result.kind === "duplicate").length, 5)
  equal(new Set(raced.map((result) => result.settlement.id)).size, 1)
  equal(await count(race.paymentInvoiceID), { settlements: 1, costs: 2 })

  const invalid = await seed("invalid")
  for (const patch of [
    { workspaceID: "wrong" },
    { merchantAccountID: "wrong" },
    { provider: "bonum" as const },
    { grossAmountMNT: 100001, netAmountMNT: 98901 },
    { netAmountMNT: 1 },
    { kind: "refund" as const },
    { paymentEventID: "missing" },
    { paymentInvoiceID: "missing" },
    {
      kind: "adjustment" as const,
      grossAmountMNT: 10000000000,
      feeAmountMNT: 9999999999,
      taxAmountMNT: 0,
      netAmountMNT: 1,
    },
  ]) {
    await rejects(() => record({ ...invalid, ...patch }))
    equal(await count(invalid.paymentInvoiceID), { settlements: 0, costs: 0 })
  }
  for (const [id, query] of [
    ["deletedinv", "update payment_invoice set time_deleted=1 where id=?"],
    ["wrongstatus", "update payment_invoice set status='cancelled' where id=?"],
    ["wrongmerchant", "update payment_invoice set merchant_account_id='changed' where id=?"],
    ["wrongamount", "update payment_invoice set amount=1 where id=?"],
  ]) {
    const stale = await seed(id)
    let calls = 0
    await rejects(() =>
      record(stale, async (callback) => {
        if (++calls === 2) await run(query, stale.paymentInvoiceID)
        return batch(callback)
      }),
    )
    equal(await count(stale.paymentInvoiceID), { settlements: 0, costs: 0 })
  }
  for (const [id, query] of [
    ["deletedevent", "update payment_event set time_deleted=1 where id=?"],
    ["rejectedevent", "update payment_event set outcome='rejected' where id=?"],
    ["wrongevent", "update payment_event set external_invoice_id='changed' where id=?"],
    ["eventamount", "update payment_event set amount=1 where id=?"],
  ]) {
    const stale = await seed(id)
    let calls = 0
    await rejects(() =>
      record(stale, async (callback) => {
        if (++calls === 2) await run(query, stale.paymentEventID)
        return batch(callback)
      }),
    )
    equal(await count(stale.paymentInvoiceID), { settlements: 0, costs: 0 })
    await rejects(() => record(stale))
  }

  // A preexisting conflicting cost must roll back the new settlement and every other cost.
  const conflict = await seed("costconflict")
  const source = await row("select id from finance_payment_settlement where payment_invoice_id='inv_qpay'")
  await run(
    "insert into finance_cost_entry(id, workspace_id, category, direction, basis, source_type, source_reference, payment_invoice_id, provider, original_amount, original_currency, amount_mnt_micros, idempotency_key, payload_hash, time_effective) values ('fco_conflict','wrong','tax','debit','actual','payment_settlement','fps_conflict',?,'qpay',100,'MNT',100000000,'settlement:fps_conflict:tax',?,?)",
    conflict.paymentInvoiceID,
    "b".repeat(64),
    now,
  )
  await rejects(() => record({ ...conflict, id: "fps_conflict" }))
  equal(await count(conflict.paymentInvoiceID), { settlements: 0, costs: 1 })
  // An explicit primary-key collision is not an idempotent replay.
  const collision = await seed("idcollision")
  await rejects(() => record({ ...collision, id: String(source?.id) }))
  equal(await count(collision.paymentInvoiceID), { settlements: 0, costs: 0 })

  const fxInput = (id: string) => ({
    rateMicromntPerUSD: 3450123456,
    source: "synthetic-reference",
    sourceReference: `fx-${id}`,
    idempotencyKey: `fx-${id}`,
    payloadHash: "d".repeat(64),
    effectiveAt: now,
  })
  const fx = (id: string, selectedBatch = batch) => native.recordFinanceFxRate(fxInput(id), { batch: selectedBatch })
  const costInput = (id: string) => ({
    workspaceID: "wrk_finance",
    category: "model_cost" as const,
    direction: "debit" as const,
    basis: "actual" as const,
    sourceType: "provider_statement" as const,
    sourceReference: `cost-${id}`,
    provider: "synthetic-provider",
    model: "synthetic-model",
    originalAmount: 150000000,
    originalCurrency: "USD" as const,
    idempotencyKey: `cost-${id}`,
    payloadHash: "e".repeat(64),
    effectiveAt: now,
  })
  const cost = (id: string, selectedBatch = batch) =>
    native.recordFinanceCostEntry(costInput(id), { batch: selectedBatch })
  const historical = await fx("historical")
  equal(historical.kind, "created")
  equal(historical.rate.rate_micromnt_per_usd, 3450123456)
  equal((await fx("historical")).kind, "duplicate")
  equal(
    (await native.recordFinanceFxRate({ ...fxInput("historical"), id: "fxr_replay_ignored" }, { batch })).rate.id,
    historical.rate.id,
  )
  for (const patch of [
    { rateMicromntPerUSD: 3450123457 },
    { source: "different" },
    { sourceReference: "different" },
    { idempotencyKey: "different-fx" },
    { payloadHash: "f".repeat(64) },
    { effectiveAt: now + 1 },
  ]) {
    await rejects(() => native.recordFinanceFxRate({ ...fxInput("historical"), ...patch }, { batch }))
    equal((await fx("historical")).rate.id, historical.rate.id)
  }
  await rejects(() => native.recordFinanceFxRate({ ...fxInput("collision"), id: historical.rate.id }, { batch }))
  equal(await row("select count(*) count from finance_fx_rate where idempotency_key='fx-collision'"), { count: 0 })
  await rejects(() => fx("rollback", rollback))
  equal(await row("select count(*) count from finance_fx_rate where idempotency_key='fx-rollback'"), { count: 0 })
  const loseEveryAck: typeof Database.batch = async (callback) => {
    await batch(callback)
    throw new Error("Synthetic lost ledger commit acknowledgement")
  }
  await rejects(() => fx("lost", loseEveryAck))
  equal((await fx("lost")).kind, "duplicate")
  const fxRace = await Promise.all(Array.from({ length: 6 }, () => fx("race")))
  equal(fxRace.filter((result) => result.kind === "created").length, 1)
  equal(fxRace.filter((result) => result.kind === "duplicate").length, 5)
  equal(new Set(fxRace.map((result) => result.rate.id)).size, 1)

  const unvalued = await cost("unvalued")
  equal(unvalued.kind, "created")
  equal(unvalued.entry.amount_mnt_micros, null)
  equal(unvalued.entry.fx_rate_id, null)
  equal((await cost("unvalued")).kind, "duplicate")
  for (const patch of [
    { workspaceID: "different" },
    { category: "adjustment" as const },
    { direction: "credit" as const },
    { basis: "estimated" as const },
    { sourceType: "manual" as const },
    { sourceReference: "different" },
    { usageID: "usg_different" },
    { paymentInvoiceID: "inv_different" },
    { paymentEventID: "pev_different" },
    { provider: "different" },
    { model: "different" },
    { originalAmount: 1 },
    { originalCurrency: "MNT" as const },
    { fxRateID: historical.rate.id },
    { idempotencyKey: "different-cost" },
    { payloadHash: "f".repeat(64) },
    { effectiveAt: now + 1 },
  ]) {
    await rejects(() => native.recordFinanceCostEntry({ ...costInput("unvalued"), ...patch }, { batch }))
    equal(
      await row(
        "select count(*) count from finance_cost_entry where idempotency_key in ('cost-unvalued','different-cost')",
      ),
      { count: 1 },
    )
  }
  const valued = await native.recordFinanceCostEntry(
    { ...costInput("valued"), fxRateID: historical.rate.id },
    { batch },
  )
  equal(valued.entry.amount_mnt_micros, 5175185184)
  equal(valued.entry.original_amount, 150000000)
  equal(valued.entry.fx_rate_id, historical.rate.id)
  equal(
    (await native.recordFinanceCostEntry({ ...costInput("valued"), fxRateID: historical.rate.id }, { batch })).kind,
    "duplicate",
  )
  equal(
    (
      await native.recordFinanceCostEntry(
        { ...costInput("mnt"), originalCurrency: "MNT", originalAmount: 250 },
        { batch },
      )
    ).entry.amount_mnt_micros,
    250000000,
  )
  const maxMnt = Math.floor(Number.MAX_SAFE_INTEGER / 1000000)
  equal(
    (
      await native.recordFinanceCostEntry(
        { ...costInput("maxmnt"), originalCurrency: "MNT", originalAmount: maxMnt },
        { batch },
      )
    ).entry.amount_mnt_micros,
    maxMnt * 1000000,
  )
  for (const patch of [
    { originalCurrency: "MNT" as const, originalAmount: maxMnt + 1 },
    { originalCurrency: "MNT" as const, fxRateID: historical.rate.id },
    { fxRateID: "missing" },
    { originalAmount: Number.MAX_SAFE_INTEGER, fxRateID: historical.rate.id },
  ]) {
    await rejects(() => native.recordFinanceCostEntry({ ...costInput("invalid"), ...patch }, { batch }))
    equal(await row("select count(*) count from finance_cost_entry where idempotency_key='cost-invalid'"), { count: 0 })
  }
  const half = await native.recordFinanceFxRate({ ...fxInput("half"), rateMicromntPerUSD: 50000000 }, { batch })
  const less = await native.recordFinanceFxRate({ ...fxInput("less"), rateMicromntPerUSD: 49999999 }, { batch })
  equal(
    (
      await native.recordFinanceCostEntry(
        { ...costInput("half"), fxRateID: half.rate.id, originalAmount: 1 },
        { batch },
      )
    ).entry.amount_mnt_micros,
    1,
  )
  await rejects(() =>
    native.recordFinanceCostEntry({ ...costInput("underflow"), fxRateID: less.rate.id, originalAmount: 1 }, { batch }),
  )
  await rejects(() => cost("rollback", rollback))
  equal(await row("select count(*) count from finance_cost_entry where idempotency_key='cost-rollback'"), { count: 0 })
  await rejects(() => cost("lost", loseEveryAck))
  equal((await cost("lost")).kind, "duplicate")
  const costRace = await Promise.all(Array.from({ length: 6 }, () => cost("race")))
  equal(costRace.filter((result) => result.kind === "created").length, 1)
  equal(costRace.filter((result) => result.kind === "duplicate").length, 5)
  equal(new Set(costRace.map((result) => result.entry.id)).size, 1)
  const conflictRace = await Promise.allSettled([
    native.recordFinanceCostEntry({ ...costInput("conflictrace"), originalAmount: 123 }, { batch }),
    native.recordFinanceCostEntry({ ...costInput("conflictrace"), originalAmount: 456 }, { batch }),
  ])
  equal(conflictRace.filter((result) => result.status === "fulfilled").length, 1)
  equal(conflictRace.filter((result) => result.status === "rejected").length, 1)

  const valuationInput = (id: string, costEntryID = unvalued.entry.id, version = 1) => ({
    costEntryID,
    fxRateID: historical.rate.id,
    method: "historical_spot" as const,
    version,
    idempotencyKey: `valuation-${id}`,
    payloadHash: "f".repeat(64),
  })
  const valuation = await native.recordFinanceCostValuation(valuationInput("first"), { batch })
  equal(valuation.kind, "created")
  equal(valuation.valuation.amount_mnt_micros, 5175185184)
  equal(
    (await native.recordFinanceCostValuation({ ...valuationInput("first"), id: "fvl_ignored_on_replay" }, { batch }))
      .valuation.id,
    valuation.valuation.id,
  )
  const latestRate = await native.recordFinanceFxRate(
    { ...fxInput("latest"), rateMicromntPerUSD: 3500000000 },
    { batch },
  )
  const correction = {
    ...valuationInput("second", unvalued.entry.id, 2),
    fxRateID: latestRate.rate.id,
    method: "provider_settlement" as const,
  }
  const corrected = await native.recordFinanceCostValuation(correction, { batch })
  equal(corrected.kind, "created")
  equal(corrected.valuation.amount_mnt_micros, 5250000000)
  equal((await native.recordFinanceCostValuation(valuationInput("first"), { batch })).kind, "duplicate")
  equal((await cost("unvalued")).entry.amount_mnt_micros, null)
  equal((await cost("unvalued")).entry.original_amount, 150000000)
  for (const patch of [
    { fxRateID: latestRate.rate.id },
    { method: "manual" as const },
    { payloadHash: "a".repeat(64) },
    { version: 3 },
    { costEntryID: costRace[0]!.entry.id },
    { idempotencyKey: "different-valuation" },
  ]) {
    await rejects(() => native.recordFinanceCostValuation({ ...valuationInput("first"), ...patch }, { batch }))
    equal(await row("select count(*) count from finance_cost_valuation where cost_entry_id=?", unvalued.entry.id), {
      count: 2,
    })
  }
  for (const input of [
    valuationInput("missing-cost", "missing"),
    { ...valuationInput("missing-fx"), fxRateID: "missing" },
    valuationInput("already-valued", valued.entry.id),
    valuationInput("out-of-order", unvalued.entry.id, 4),
  ])
    await rejects(() => native.recordFinanceCostValuation(input, { batch }))
  const rolling = await cost("rollbackvaluation")
  let valuationCalls = 0
  await rejects(() =>
    native.recordFinanceCostValuation(valuationInput("rollback", rolling.entry.id), {
      batch: (callback) => (++valuationCalls === 2 ? rollback(callback) : batch(callback)),
    }),
  )
  equal(valuationCalls, 2)
  equal(await row("select count(*) count from finance_cost_valuation where cost_entry_id=?", rolling.entry.id), {
    count: 0,
  })
  equal((await cost("rollbackvaluation")).entry.amount_mnt_micros, null)
  let lostValuationCalls = 0
  await rejects(() =>
    native.recordFinanceCostValuation(valuationInput("lost", rolling.entry.id), {
      batch: (callback) => (++lostValuationCalls === 2 ? loseEveryAck(callback) : batch(callback)),
    }),
  )
  equal(
    (await native.recordFinanceCostValuation(valuationInput("lost", rolling.entry.id), { batch })).kind,
    "duplicate",
  )

  const concurrentCost = await cost("valuationrace")
  const valuationBarrier = Promise.withResolvers<void>()
  let valuationReaders = 0
  const synchronizedValuation = () => {
    let calls = 0
    const selected: typeof Database.batch = async (callback) => {
      const result = await batch(callback)
      if (++calls === 1) {
        if (++valuationReaders === 6) valuationBarrier.resolve()
        await valuationBarrier.promise
      }
      return result
    }
    return selected
  }
  const valuationRace = await Promise.all(
    Array.from({ length: 6 }, () =>
      native.recordFinanceCostValuation(valuationInput("race", concurrentCost.entry.id), {
        batch: synchronizedValuation(),
      }),
    ),
  )
  equal(valuationRace.filter((result) => result.kind === "created").length, 1)
  equal(valuationRace.filter((result) => result.kind === "duplicate").length, 5)
  equal(new Set(valuationRace.map((result) => result.valuation.id)).size, 1)
  const valuationConflict = await Promise.allSettled([
    native.recordFinanceCostValuation(valuationInput("competing-a", concurrentCost.entry.id, 2), { batch }),
    native.recordFinanceCostValuation(
      { ...valuationInput("competing-b", concurrentCost.entry.id, 2), fxRateID: latestRate.rate.id },
      { batch },
    ),
  ])
  equal(valuationConflict.filter((result) => result.status === "fulfilled").length, 1)
  equal(valuationConflict.filter((result) => result.status === "rejected").length, 1)
  equal(
    await row(
      "select count(*) count, max(version) latest from finance_cost_valuation where cost_entry_id=?",
      concurrentCost.entry.id,
    ),
    { count: 2, latest: 2 },
  )
  // Native trigger checks protect the ledger even from direct SQL writes.
  for (const [table, id, field] of [
    ["finance_fx_rate", historical.rate.id, "rate_micromnt_per_usd"],
    ["finance_cost_entry", unvalued.entry.id, "original_amount"],
    ["finance_cost_valuation", valuation.valuation.id, "amount_mnt_micros"],
  ]) {
    await rejects(() => run(`update ${table} set ${field}=1 where id=?`, id))
    await rejects(() => run(`delete from ${table} where id=?`, id))
  }
  equal((await fx("historical")).rate.rate_micromnt_per_usd, 3450123456)
  equal((await cost("unvalued")).entry.original_amount, 150000000)
  equal(
    (await native.recordFinanceCostValuation(valuationInput("first"), { batch })).valuation.amount_mnt_micros,
    5175185184,
  )

  console.log(`FINANCE_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Finance test escaped temp root")
  await rm(persistTo, { recursive: true, force: true })
}

function equal(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected)
  checks++
}
async function rejects(action: () => Promise<unknown>) {
  await assert.rejects(action)
  checks++
}
