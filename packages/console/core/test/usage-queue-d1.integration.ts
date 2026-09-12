import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { UsageQueueEvent } from "../src/quota"

const native: typeof import("./fixtures/usage-queue-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-usage-d1-"))
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
  const seed = async (id: string): Promise<UsageQueueEvent> => {
    await binding.batch([
      binding.prepare("insert into workspace(id,name) values (?, 'Synthetic usage')").bind(`wrk_${id}`),
      binding
        .prepare("insert into billing(id,workspace_id,balance,monthly_usage) values (?,?,10000,0)")
        .bind(`bil_${id}`, `wrk_${id}`),
      binding
        .prepare("insert into user(id,workspace_id,name,role,monthly_usage) values (?,?,'User','admin',0)")
        .bind(`usr_${id}`, `wrk_${id}`),
    ])
    return {
      version: 1,
      id: `usg_${id}`,
      workspaceID: `wrk_${id}`,
      userID: `usr_${id}`,
      timeCreated: now,
      workspaceCost: 125,
      userCost: 125,
      usage: {
        model: "synthetic-model",
        provider: "synthetic-provider",
        inputTokens: 10,
        outputTokens: 20,
        cost: 125,
        sessionID: `ses_${id}`,
        enrichment: { plan: "balance" },
      },
    }
  }
  const record = (event: UsageQueueEvent, selectedBatch = batch) =>
    native.persistUsageQueueEvent(event, { batch: selectedBatch })
  const counts = (event: UsageQueueEvent) =>
    row(
      "select (select count(*) from usage where workspace_id=?) usages, (select count(*) from finance_cost_entry where workspace_id=?) costs",
      event.workspaceID,
      event.workspaceID,
    )
  const state = (event: UsageQueueEvent) =>
    row(
      "select b.balance, b.monthly_usage workspace_usage, u.monthly_usage user_usage from billing b join user u on u.workspace_id=b.workspace_id where b.workspace_id=? and u.id=?",
      event.workspaceID,
      event.userID,
    )
  const initial = { balance: 10000, workspace_usage: 0, user_usage: 0 }
  const charged = { balance: 9875, workspace_usage: 125, user_usage: 125 }
  const first = await seed("first")
  equal(await record(first), "inserted")
  equal(await record(first), "duplicate")
  equal(await counts(first), { usages: 1, costs: 1 })
  equal(await state(first), charged)
  equal(
    await row(
      "select original_amount, original_currency, amount_mnt_micros, fx_rate_id, basis, source_type from finance_cost_entry where usage_id=?",
      first.id,
    ),
    {
      original_amount: 125,
      original_currency: "USD",
      amount_mnt_micros: null,
      fx_rate_id: null,
      basis: "estimated",
      source_type: "usage",
    },
  )
  for (const patch of [
    { model: "different" },
    { provider: "different" },
    { inputTokens: 11 },
    { outputTokens: 21 },
    { reasoningTokens: 1 },
    { cacheReadTokens: 1 },
    { cacheWrite5mTokens: 1 },
    { cacheWrite1hTokens: 1 },
    { cost: 126 },
    { inputCost: 1 },
    { outputCost: 1 },
    { cacheReadCost: 1 },
    { cacheWriteCost: 1 },
    { country: "MN" },
    { continent: "AS" },
    { keyID: "key_different" },
    { sessionID: "ses_different" },
    { enrichment: { plan: "byok" as const } },
  ]) {
    await rejects(() => record({ ...first, usage: { ...first.usage, ...patch } }))
    equal(await state(first), charged)
  }
  await rejects(() => record({ ...first, userID: "missing" }))
  await rejects(() => record({ ...first, timeCreated: now + 1 }))
  equal(await state(first), charged)
  // Repeated delivery never applies different charge deltas a second time.
  equal(await record({ ...first, workspaceCost: 9000, userCost: 9000 }), "duplicate")
  equal(await state(first), charged)

  const race = await seed("race")
  const raced = await Promise.all(Array.from({ length: 8 }, () => record(race)))
  equal(raced.filter((result) => result === "inserted").length, 1)
  equal(raced.filter((result) => result === "duplicate").length, 7)
  equal(await state(race), charged)
  equal(await counts(race), { usages: 1, costs: 1 })
  const unique = await seed("unique")
  equal(
    (
      await Promise.all(Array.from({ length: 8 }, (_, index) => record({ ...unique, id: `usg_unique_${index}` })))
    ).filter((result) => result === "inserted").length,
    8,
  )
  equal(await state(unique), { balance: 9000, workspace_usage: 1000, user_usage: 1000 })
  equal(await counts(unique), { usages: 8, costs: 8 })

  const lost = await seed("lost")
  await rejects(() =>
    record(lost, async (callback) => {
      await batch(callback)
      throw new Error("Synthetic lost usage acknowledgement")
    }),
  )
  equal(await state(lost), charged)
  equal(await record(lost), "duplicate")
  equal(await counts(lost), { usages: 1, costs: 1 })
  equal(await state(lost), charged)
  const rollback = await seed("rollback")
  const doomed = (async (callback: Parameters<typeof Database.batch>[0]) => {
    const failure = db.select({ value: native.sql<number>`json_extract('invalid', '$')` }).from(native.sql`(select 1)`)
    return (await db.batch([...callback(db), failure])).slice(0, -1)
  }) as typeof Database.batch
  await rejects(() => record(rollback, doomed))
  equal(await state(rollback), initial)
  equal(await counts(rollback), { usages: 0, costs: 0 })
  equal(await record(rollback), "inserted")

  const costFailure = await seed("costfail")
  await run(
    "create trigger synthetic_usage_cost_failure before insert on finance_cost_entry when NEW.usage_id='usg_costfail' begin select raise(ABORT, 'synthetic provider cost failure'); end",
  )
  await rejects(() => record(costFailure))
  equal(await state(costFailure), initial)
  equal(await counts(costFailure), { usages: 0, costs: 0 })
  await run("drop trigger synthetic_usage_cost_failure")
  equal(await record(costFailure), "inserted")
  for (const table of ["billing", "user"]) {
    const missing = await seed(`missing_${table}`)
    await run(`delete from ${table} where workspace_id=?`, missing.workspaceID)
    await rejects(() => record(missing))
    equal(await counts(missing), { usages: 0, costs: 0 })
    if (table === "user")
      equal(await row("select balance from billing where workspace_id=?", missing.workspaceID), { balance: 10000 })
    else
      equal(await row("select monthly_usage from user where workspace_id=?", missing.workspaceID), { monthly_usage: 0 })
  }

  const newer = await seed("newer")
  equal(await record({ ...newer, timeCreated: Date.UTC(2026, 9, 1) }), "inserted")
  equal(await record({ ...newer, id: "usg_older", timeCreated: Date.UTC(2026, 8, 30) }), "inserted")
  equal(await state(newer), { balance: 9750, workspace_usage: 125, user_usage: 125 })
  equal(await record({ ...newer, id: "usg_october", timeCreated: Date.UTC(2026, 9, 2) }), "inserted")
  equal(await state(newer), { balance: 9625, workspace_usage: 250, user_usage: 250 })
  equal(await record({ ...newer, id: "usg_november", timeCreated: Date.UTC(2026, 10, 1) }), "inserted")
  equal(await state(newer), { balance: 9500, workspace_usage: 125, user_usage: 125 })
  for (const kind of ["byok", "zero"] as const) {
    const event = await seed(kind)
    const input = {
      ...event,
      workspaceCost: 0,
      userCost: kind === "zero" ? 0 : 125,
      usage: {
        ...event.usage,
        cost: kind === "zero" ? 0 : 125,
        enrichment: kind === "byok" ? { plan: "byok" as const } : undefined,
      },
    }
    equal(await record(input), "inserted")
    equal(await record(input), "duplicate")
    equal(await counts(event), { usages: 1, costs: 0 })
    equal(await state(event), { balance: 10000, workspace_usage: 0, user_usage: kind === "zero" ? 0 : 125 })
  }
  const cross = await seed("cross")
  await rejects(() => record({ ...cross, id: first.id }))
  equal(await counts(cross), { usages: 0, costs: 0 })
  equal(await state(cross), initial)
  equal(await state(first), charged)
  for (const kind of ["free", "byok", "balance"] as const) {
    const event = await seed(`direct_${kind}`)
    event.usage.enrichment = kind === "free" ? undefined : { plan: kind }
    const debit = kind === "balance" ? 125 : 0
    equal(await native.persistGatewayUsageEvent(event, { balanceCost: debit }, { batch }), true)
    equal(await native.persistGatewayUsageEvent(event, { balanceCost: debit }, { batch }), true)
    equal(await state(event), { balance: 10000 - debit, workspace_usage: 125, user_usage: 125 })
    equal(await counts(event), { usages: 1, costs: kind === "byok" ? 0 : 1 })
  }
  const fallback = await seed("queue_fallback")
  fallback.workspaceCost = 0
  fallback.usage.enrichment = undefined
  equal(
    (await Promise.all([record(fallback), native.persistGatewayUsageEvent(fallback, { balanceCost: 0 }, { batch })]))
      .length,
    2,
  )
  equal(await state(fallback), { balance: 10000, workspace_usage: 0, user_usage: 125 })
  equal(await counts(fallback), { usages: 1, costs: 1 })

  const planSeed = async (id: string) => {
    const event = await seed(id)
    event.usage.enrichment = { plan: "pro" }
    await run(
      "insert into plan_subscription(id,workspace_id,invoice_id,plan,status,time_period_start,time_period_end) values (?,?,?,'pro','active',?,?)",
      `pln_${id}`,
      event.workspaceID,
      `inv_${id}`,
      Date.UTC(2026, 7, 20, 8),
      Date.UTC(2026, 11, 20, 8),
    )
    return event
  }
  const planRecord = (event: UsageQueueEvent, selectedBatch = batch) =>
    native.persistGatewayUsageEvent(
      event,
      {
        entitlementID: `pln_${event.workspaceID.slice(4)}`,
        tokens: 30,
        rollingWindowHours: 5,
      },
      { batch: selectedBatch },
    )
  const planState = (event: UsageQueueEvent) =>
    row(
      "select fixed_usage,weekly_tokens,weekly_requests,monthly_cost,monthly_tokens,monthly_requests,rolling_usage from subscription where workspace_id=? and user_id=?",
      event.workspaceID,
      event.userID,
    )
  const measured = {
    fixed_usage: 125,
    weekly_tokens: 30,
    weekly_requests: 1,
    monthly_cost: 125,
    monthly_tokens: 30,
    monthly_requests: 1,
    rolling_usage: 125,
  }
  const plan = await planSeed("plan_first")
  equal(await planRecord(plan), true)
  equal(await planRecord(plan), true)
  equal(await planState(plan), measured)
  equal(await state(plan), initial)
  equal(await counts(plan), { usages: 1, costs: 1 })
  await rejects(() => planRecord({ ...plan, usage: { ...plan.usage, outputTokens: 99 } }))
  equal(await planState(plan), measured)
  const planRace = await planSeed("plan_race")
  equal((await Promise.all(Array.from({ length: 8 }, () => planRecord(planRace)))).every(Boolean), true)
  equal(await planState(planRace), measured)
  equal(await counts(planRace), { usages: 1, costs: 1 })
  const planUnique = await planSeed("plan_unique")
  equal(
    (
      await Promise.all(
        Array.from({ length: 8 }, (_, index) => planRecord({ ...planUnique, id: `usg_plan_unique_${index}` })),
      )
    ).every(Boolean),
    true,
  )
  equal(await planState(planUnique), {
    fixed_usage: 1000,
    weekly_tokens: 240,
    weekly_requests: 8,
    monthly_cost: 1000,
    monthly_tokens: 240,
    monthly_requests: 8,
    rolling_usage: 1000,
  })
  equal(await counts(planUnique), { usages: 8, costs: 8 })

  for (const [index, mutation] of [
    "status='refunded'",
    `time_period_end=${now}`,
    `time_deleted=${now}`,
    "plan='max'",
    `time_period_start=${Date.UTC(2026, 8, 1)}`,
    "invoice_id='inv_changed_snapshot'",
  ].entries()) {
    const event = await planSeed(`plan_stale_${index}`)
    let calls = 0
    const changed: typeof Database.batch = async (callback) => {
      if (++calls === 2) await run(`update plan_subscription set ${mutation} where workspace_id=?`, event.workspaceID)
      return batch(callback)
    }
    equal(await planRecord(event, changed), false)
    equal(await planState(event), null)
    equal(await counts(event), { usages: 1, costs: 1 })
    equal(await state(event), initial)
    equal(await planRecord(event), true)
    equal(await planState(event), null)
  }
  const ended = await planSeed("plan_ended")
  await run("update plan_subscription set time_period_end=? where workspace_id=?", now, ended.workspaceID)
  equal(await planRecord(ended), false)
  equal(await counts(ended), { usages: 1, costs: 1 })
  equal(await planState(ended), null)
  const replaced = await planSeed("plan_replaced")
  equal(await planRecord(replaced), true)
  let replacedCalls = 0
  const replace: typeof Database.batch = async (callback) => {
    if (++replacedCalls === 2) {
      await run("update plan_subscription set status='refunded' where workspace_id=?", replaced.workspaceID)
      await run(
        "insert into plan_subscription(id,workspace_id,invoice_id,plan,status,time_period_start,time_period_end) values ('pln_replacement',?,'inv_replacement','max','active',?,?)",
        replaced.workspaceID,
        now,
        now + 86400000,
      )
    }
    return batch(callback)
  }
  equal(await planRecord({ ...replaced, id: "usg_replaced_late" }, replace), false)
  equal(await planState(replaced), measured)
  equal(await counts(replaced), { usages: 2, costs: 2 })

  const atomic = await planSeed("plan_atomic")
  let atomicCalls = 0
  await rejects(() => planRecord(atomic, (callback) => (++atomicCalls === 1 ? batch(callback) : doomed(callback))))
  equal(await planState(atomic), null)
  equal(await counts(atomic), { usages: 0, costs: 0 })
  await run(
    "create trigger synthetic_plan_cost_failure before insert on finance_cost_entry when NEW.usage_id='usg_plan_atomic' begin select raise(ABORT, 'synthetic cost failure'); end",
  )
  await rejects(() => planRecord(atomic))
  equal(await planState(atomic), null)
  equal(await counts(atomic), { usages: 0, costs: 0 })
  await run("drop trigger synthetic_plan_cost_failure")
  let lostCalls = 0
  await rejects(() =>
    planRecord(atomic, async (callback) => {
      const result = await batch(callback)
      if (++lostCalls === 2) throw new Error("Synthetic lost plan acknowledgement")
      return result
    }),
  )
  equal(await planState(atomic), measured)
  equal(await planRecord(atomic), true)
  equal(await planState(atomic), measured)
  equal(await counts(atomic), { usages: 1, costs: 1 })

  const ordered = await planSeed("plan_ordered")
  equal(await planRecord({ ...ordered, timeCreated: Date.UTC(2026, 8, 21, 8) }), true)
  equal(await planRecord({ ...ordered, id: "usg_plan_previous", timeCreated: Date.UTC(2026, 8, 12, 8) }), true)
  equal(await planState(ordered), measured)
  equal(await planRecord({ ...ordered, id: "usg_plan_same", timeCreated: Date.UTC(2026, 8, 22, 8) }), true)
  equal(await planState(ordered), {
    ...measured,
    fixed_usage: 250,
    weekly_tokens: 60,
    weekly_requests: 2,
    monthly_cost: 250,
    monthly_tokens: 60,
    monthly_requests: 2,
  })
  equal(await planRecord({ ...ordered, id: "usg_plan_next", timeCreated: Date.UTC(2026, 9, 20, 8) }), true)
  equal(await planState(ordered), measured)
  equal(await counts(ordered), { usages: 4, costs: 4 })
  console.log(`USAGE_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Usage test escaped temp root")
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
