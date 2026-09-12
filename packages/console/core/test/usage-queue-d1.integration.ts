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
