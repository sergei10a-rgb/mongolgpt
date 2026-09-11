import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { PaymentProviderAdapter } from "../src/payment-provider"

const native: typeof import("./fixtures/payment-checkout-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-checkout-d1-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined
let checks = 0
const now = 2_000_000_000_000
const catalog = {
  basic: { label: "Basic", amount: 19000 },
  pro: { label: "Pro", amount: 49000 },
  max: { label: "Max", amount: 99000 },
}

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
  // An interactive transaction is genuinely unsupported, not emulated by this fixture.
  await rejects(
    db.transaction(async () => undefined),
    (error) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      /D1_ERROR:.*SQL BEGIN TRANSACTION/.test(error.cause.message),
  )
  const directory = fileURLToPath(new URL("../migrations-d1/", import.meta.url))
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!(await readdir(join(directory, entry.name))).includes("migration.sql")) continue
    for (const query of unstable_splitSqlQuery(await readFile(join(directory, entry.name, "migration.sql"), "utf8")))
      await binding.prepare(query).run()
  }
  async function fixture(id: string) {
    const accountID = `acc_${id}`
    const workspaceID = `wrk_${id}`
    await binding.batch([
      binding.prepare("insert into account (id) values (?)").bind(accountID),
      binding.prepare("insert into workspace (id,name) values (?,?)").bind(workspaceID, "Synthetic checkout"),
      binding
        .prepare("insert into user (id,workspace_id,account_id,role,name) values (?,?,?,'admin','Test')")
        .bind(`usr_${id}`, workspaceID, accountID),
    ])
    const request = {
      accountID,
      workspaceID,
      requestKey: randomUUID(),
      provider: "qpay" as const,
      plan: "pro" as const,
    }
    let calls = 0
    const adapter: PaymentProviderAdapter = {
      provider: "qpay",
      merchantAccountID: "synthetic-merchant",
      async createInvoice(input) {
        calls++
        equal(await row("select status from payment_checkout where id = ?", input.reference), { status: "creating" })
        return {
          provider: "qpay",
          merchantAccountID: "synthetic-merchant",
          externalInvoiceID: `external-${id}-${calls}`,
          qrText: "synthetic-qr",
          deepLinks: [],
        }
      },
    }
    const dependencies = { adapter, catalog, batch, now: () => now }
    return { request, dependencies, calls: () => calls }
  }
  const states = (workspace: string) =>
    row(
      "select c.status checkout, i.status ledger from payment_checkout c left join payment_invoice i on i.id = c.id where c.workspace_id = ? order by c.time_created desc, c.id desc limit 1",
      workspace,
    )
  const count = (workspace: string) =>
    row("select count(*) count from payment_checkout where workspace_id = ?", workspace)
  const create = native.createSubscriptionCheckout

  const ready = await fixture("ready")
  const first = await create(ready.request, ready.dependencies)
  equal(first.status, "ready")
  equal(await create(ready.request, ready.dependencies), first)
  equal(ready.calls(), 1)
  equal(await states(ready.request.workspaceID), { checkout: "ready", ledger: "created" })
  await rejects(create({ ...ready.request, plan: "max" }, ready.dependencies), /дахин илгээхэд/)
  await rejects(create({ ...ready.request, requestKey: randomUUID() }, ready.dependencies), { state: "open_checkout" })
  equal(ready.calls(), 1)

  const race = await fixture("race")
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => create({ ...race.request, requestKey: randomUUID() }, race.dependencies)),
  )
  equal(results.filter((result) => result.status === "fulfilled").length, 1)
  equal(results.filter((result) => result.status === "rejected" && result.reason.state === "open_checkout").length, 7)
  equal(race.calls(), 1)
  equal(await count(race.request.workspaceID), { count: 1 })
  equal(await states(race.request.workspaceID), { checkout: "ready", ledger: "created" })

  const forbidden = await fixture("forbidden")
  await rejects(create({ ...forbidden.request, accountID: "acc_foreign" }, forbidden.dependencies), {
    name: "PaymentCheckoutAuthorizationError",
  })
  await run("update user set role = 'member' where account_id = ?", forbidden.request.accountID)
  await rejects(create(forbidden.request, forbidden.dependencies), { name: "PaymentCheckoutAuthorizationError" })
  equal(forbidden.calls(), 0)
  equal(await count(forbidden.request.workspaceID), { count: 0 })

  const active = await fixture("active")
  await run(
    "insert into plan_subscription (id,workspace_id,invoice_id,plan,status,time_period_start,time_period_end) values ('sub_active',?,'inv_active','pro','active',?,?)",
    active.request.workspaceID,
    now - 1000,
    now + 86400000,
  )
  await rejects(create(active.request, active.dependencies), { state: "active_subscription" })
  equal(active.calls(), 0)
  equal(await count(active.request.workspaceID), { count: 0 })

  for (const [status, state] of [
    [400, "failed"],
    [503, "unknown"],
  ] as const) {
    const failure = await fixture(`reject_${status}`)
    let calls = 0
    const dependencies = {
      ...failure.dependencies,
      adapter: {
        ...failure.dependencies.adapter,
        async createInvoice(): Promise<never> {
          calls++
          throw new native.PaymentProviderResponseError({ provider: "qpay", operation: "create invoice", status })
        },
      },
    }
    await rejects(create(failure.request, dependencies), { state, code: `provider_${status}` })
    equal(await states(failure.request.workspaceID), { checkout: state, ledger: null })
    await rejects(create(failure.request, dependencies), {
      state: state === "unknown" ? "request_in_progress" : "request_closed",
    })
    equal(calls, 1)
  }

  const lostReservation = await fixture("lost_reserve")
  const lostAck: typeof Database.batch = async (callback) => {
    await batch(callback)
    throw new Error("lost acknowledgement")
  }
  await rejects(
    create(lostReservation.request, { ...lostReservation.dependencies, batch: lostAck }),
    /lost acknowledgement/,
  )
  equal(lostReservation.calls(), 0)
  await rejects(create(lostReservation.request, lostReservation.dependencies), { state: "request_in_progress" })
  equal(lostReservation.calls(), 0)
  equal(await states(lostReservation.request.workspaceID), { checkout: "creating", ledger: null })

  const lostCompletion = await fixture("lost_complete")
  let completions = 0
  const lostOnce: typeof Database.batch = async (callback) => {
    const result = await batch(callback)
    if (++completions === 2) throw new Error("lost completion acknowledgement")
    return result
  }
  equal((await create(lostCompletion.request, { ...lostCompletion.dependencies, batch: lostOnce })).status, "ready")
  equal(completions, 3)
  equal(lostCompletion.calls(), 1)
  equal(await states(lostCompletion.request.workspaceID), { checkout: "ready", ledger: "created" })

  const rollback = (async (callback: Parameters<typeof Database.batch>[0]) => {
    const queries = callback(db)
    const doomed = db
      .select({ value: native.sql<number>`json_extract('invalid', '$')` })
      .from(native.sql`account`)
      .limit(1)
    return (await db.batch([...queries, doomed])).slice(0, -1)
  }) as typeof Database.batch
  const atomic = await fixture("atomic")
  await rejects(create(atomic.request, { ...atomic.dependencies, batch: rollback }), /malformed JSON/)
  equal(await count(atomic.request.workspaceID), { count: 0 })
  equal(atomic.calls(), 0)
  let attempts = 0
  const failedCompletion: typeof Database.batch = (callback) =>
    ++attempts === 2 || attempts === 3 ? rollback(callback) : batch(callback)
  await rejects(create(atomic.request, { ...atomic.dependencies, batch: failedCompletion }), {
    state: "unknown",
    code: "persistence_failed",
  })
  equal(atomic.calls(), 1)
  equal(await states(atomic.request.workspaceID), { checkout: "unknown", ledger: null })

  const foreign = await fixture("foreign")
  await rejects(
    create(foreign.request, {
      ...foreign.dependencies,
      adapter: {
        ...foreign.dependencies.adapter,
        async createInvoice() {
          return first.checkout
        },
      },
    }),
    { state: "unknown", code: "persistence_failed" },
  )
  equal(await states(foreign.request.workspaceID), { checkout: "unknown", ledger: null })
  equal(await states(ready.request.workspaceID), { checkout: "ready", ledger: "created" })

  const deleted = await fixture("deleted")
  await rejects(
    create(deleted.request, {
      ...deleted.dependencies,
      adapter: {
        ...deleted.dependencies.adapter,
        async createInvoice(input) {
          const value = await deleted.dependencies.adapter.createInvoice(input)
          await run("update payment_checkout set time_deleted = ? where id = ?", now, input.reference)
          return value
        },
      },
    }),
    { state: "unknown", code: "persistence_failed" },
  )
  equal(await states(deleted.request.workspaceID), { checkout: "creating", ledger: null })
  await rejects(create(deleted.request, deleted.dependencies), { state: "request_closed" })
  equal(deleted.calls(), 1)

  // No expiry before the grace deadline; a failed batch cannot expire only one side.
  equal(await native.expireOpenPaymentCheckouts(now + 19 * 60000, 100, { batch }), 0)
  await rejects(native.expireOpenPaymentCheckouts(now + 21 * 60000, 1, { batch: rollback }), /malformed JSON/)
  equal(await states(ready.request.workspaceID), { checkout: "ready", ledger: "created" })
  equal(await native.expireOpenPaymentCheckouts(now + 21 * 60000, 1, { batch }), 1)
  equal(await row("select count(*) count from payment_checkout where status = 'expired'"), { count: 1 })
  await native.expireOpenPaymentCheckouts(now + 21 * 60000, 100, { batch })
  equal(await states(ready.request.workspaceID), { checkout: "expired", ledger: "expired" })
  equal(await states(deleted.request.workspaceID), { checkout: "creating", ledger: null })
  equal(await native.expireOpenPaymentCheckouts(now + 21 * 60000, 100, { batch }), 0)

  const rollover = await fixture("rollover")
  const old = await create(rollover.request, rollover.dependencies)
  const next = await create(
    { ...rollover.request, requestKey: randomUUID() },
    { ...rollover.dependencies, now: () => now + 21 * 60000 },
  )
  equal(next.status, "ready")
  equal(rollover.calls(), 2)
  equal(await row("select status from payment_checkout where id = ?", old.invoiceID), { status: "expired" })
  equal(await row("select status from payment_invoice where id = ?", old.invoiceID), { status: "expired" })
  equal(await states(rollover.request.workspaceID), { checkout: "ready", ledger: "created" })
  console.log(`CHECKOUT_D1_RESULT ${JSON.stringify({ ok: true, checks, remoteBindings: false, merchantCalls: 0 })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Checkout persistence escaped temp root")
  await rm(persistTo, { recursive: true, force: true })
}

function equal(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected)
  checks++
}
async function rejects(
  promise: Promise<unknown>,
  expected: RegExp | Record<string, unknown> | ((error: unknown) => boolean),
) {
  await assert.rejects(promise, expected)
  checks++
}
