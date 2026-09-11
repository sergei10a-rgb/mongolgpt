import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { ApplyPaymentEventInput } from "../src/payment-ledger"

const native: typeof import("./fixtures/payment-settlement-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-settlement-d1-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined
let checks = 0
const now = Date.UTC(2026, 0, 31, 10)
const end = Date.UTC(2026, 1, 28, 10)
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
  const directory = fileURLToPath(new URL("../migrations-d1/", import.meta.url))
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!(await readdir(join(directory, entry.name))).includes("migration.sql")) continue
    for (const query of unstable_splitSqlQuery(await readFile(join(directory, entry.name, "migration.sql"), "utf8")))
      await binding.prepare(query).run()
  }
  async function fixture(id: string) {
    const workspace = `wrk_${id}`
    await binding.batch([
      binding.prepare("insert into account (id) values (?)").bind(`acc_${id}`),
      binding.prepare("insert into workspace (id,name) values (?, 'Synthetic payment')").bind(workspace),
      binding
        .prepare(
          "insert into user (id,workspace_id,account_id,role,name) values (?,?,?,'admin','Owner'), (?, ?, null, 'member', 'Member')",
        )
        .bind(`usr_${id}`, workspace, `acc_${id}`, `usr_${id}_2`, workspace),
      binding.prepare("insert into billing (id,workspace_id,balance) values (?,?,0)").bind(`bil_${id}`, workspace),
    ])
    const checkout = await native.createSubscriptionCheckout(
      { accountID: `acc_${id}`, workspaceID: workspace, requestKey: randomUUID(), provider: "qpay", plan: "pro" },
      {
        batch,
        catalog,
        now: () => now,
        adapter: {
          provider: "qpay",
          merchantAccountID: "synthetic-merchant",
          async createInvoice() {
            return {
              provider: "qpay",
              merchantAccountID: "synthetic-merchant",
              externalInvoiceID: `external-${id}`,
              deepLinks: [],
            }
          },
        },
      },
    )
    const event: ApplyPaymentEventInput = {
      provider: "qpay",
      merchantAccountID: "synthetic-merchant",
      externalEventID: `paid-${id}`,
      externalInvoiceID: `external-${id}`,
      externalPaymentID: `payment-${id}`,
      amount: 49000,
      currency: "MNT",
      type: "paid",
      payloadHash: "a".repeat(64),
      occurredAt: now,
    }
    return { workspace, checkout, event }
  }
  const apply = (event: ApplyPaymentEventInput, selectedBatch = batch, time = now) =>
    native.applyPaymentQueueEvent(
      native.createPaymentQueueEvent(event, time),
      native.createPlanSubscriptionPaymentBatchEffect({ now: () => time }),
      { batch: selectedBatch },
    )
  const state = (id: string) =>
    row(
      "select c.status checkout, i.status invoice from payment_checkout c join payment_invoice i on i.id = c.id where c.id = ?",
      id,
    )
  const events = (id: string) => row("select count(*) count from payment_event where invoice_id = ?", id)
  const usage = (workspace: string) =>
    row(
      "select count(*) count, count(distinct id) ids, sum(coalesce(weekly_tokens,0)) tokens from subscription where workspace_id = ?",
      workspace,
    )
  const plans = (workspace: string) =>
    row("select count(*) count from plan_subscription where workspace_id = ?", workspace)
  const rollback = (async (callback: Parameters<typeof Database.batch>[0]) => {
    const doomed = db
      .select({ value: native.sql<number>`json_extract('invalid', '$')` })
      .from(native.sql`account`)
      .limit(1)
    return (await db.batch([...callback(db), doomed])).slice(0, -1)
  }) as typeof Database.batch

  const ready = await fixture("settle")
  const paid = await native.applyPaymentEvent(
    ready.event,
    (context) => {
      equal(context.invoice.time_verified?.getTime(), now)
      return native.createPlanSubscriptionPaymentBatchEffect({ now: () => now })(context)
    },
    { batch },
  )
  equal(paid.kind, "applied")
  equal(await state(ready.checkout.invoiceID), { checkout: "paid", invoice: "paid" })
  equal(
    await row(
      "select status, plan, time_period_start start, time_period_end end from plan_subscription where invoice_id = ?",
      ready.checkout.invoiceID,
    ),
    { status: "active", plan: "pro", start: now, end },
  )
  equal(await usage(ready.workspace), { count: 2, ids: 2, tokens: 0 })
  equal(
    await row(
      "select json_extract(subscription,'$.invoiceID') invoice, json_extract(subscription,'$.source') source from billing where workspace_id = ?",
      ready.workspace,
    ),
    { invoice: ready.checkout.invoiceID, source: "qpay" },
  )
  await run("update subscription set weekly_tokens = 7 where workspace_id = ?", ready.workspace)
  equal((await apply(ready.event)).kind, "duplicate")
  equal((await apply({ ...ready.event, externalEventID: "another-paid" })).kind, "noop")
  equal(await usage(ready.workspace), { count: 2, ids: 2, tokens: 14 })
  equal(await plans(ready.workspace), { count: 1 })
  equal((await apply({ ...ready.event, type: "failed", externalEventID: "late-failed" })).kind, "rejected")
  equal(await state(ready.checkout.invoiceID), { checkout: "paid", invoice: "paid" })
  await rejects(apply({ ...ready.event, payloadHash: "b".repeat(64) }), /дахин илгээхэд/)
  await rejects(apply({ ...ready.event, amount: 1, externalEventID: "wrong-amount" }), /дүн эсвэл валют/)
  await rejects(
    apply({ ...ready.event, externalPaymentID: "wrong-payment", externalEventID: "wrong-payment" }),
    /өөр гадаад төлбөр/,
  )
  equal(await events(ready.checkout.invoiceID), { count: 3 })

  // Older billing records can identify the paid invoice without carrying a provider source.
  await run(
    "update billing set subscription = json_remove(subscription, '$.source') where workspace_id = ?",
    ready.workspace,
  )

  const refund = {
    ...ready.event,
    type: "refunded" as const,
    externalEventID: "refund-settle",
    payloadHash: "c".repeat(64),
    occurredAt: now + 1000,
  }
  equal((await apply(refund)).kind, "applied")
  equal(await state(ready.checkout.invoiceID), { checkout: "refunded", invoice: "refunded" })
  equal(await usage(ready.workspace), { count: 0, ids: 0, tokens: null })
  equal(await row("select subscription, subscription_id from billing where workspace_id = ?", ready.workspace), {
    subscription: null,
    subscription_id: null,
  })
  equal(await row("select status from plan_subscription where invoice_id = ?", ready.checkout.invoiceID), {
    status: "refunded",
  })
  equal((await apply(refund)).kind, "duplicate")

  const concurrent = await fixture("concurrent")
  const sameID = { ...concurrent.event, id: "pev_same_request" }
  const raced = await Promise.allSettled(Array.from({ length: 8 }, () => apply(sameID)))
  equal(raced.filter((result) => result.status === "fulfilled" && result.value.kind === "applied").length, 1)
  // Model the queue's redelivery after an optimistic snapshot conflict, never a second charge.
  for (const result of raced) if (result.status === "rejected") equal((await apply(sameID)).kind, "duplicate")
  equal(await events(concurrent.checkout.invoiceID), { count: 1 })
  equal(await plans(concurrent.workspace), { count: 1 })
  equal(await usage(concurrent.workspace), { count: 2, ids: 2, tokens: 0 })

  const atomic = await fixture("atomic_event")
  let batches = 0
  const failWrite: typeof Database.batch = (callback) => (++batches === 2 ? rollback(callback) : batch(callback))
  await rejects(apply(atomic.event, failWrite), /malformed JSON/)
  equal(await events(atomic.checkout.invoiceID), { count: 0 })
  equal(await plans(atomic.workspace), { count: 0 })
  equal(await state(atomic.checkout.invoiceID), { checkout: "ready", invoice: "created" })
  equal(await usage(atomic.workspace), { count: 0, ids: 0, tokens: null })
  equal(await row("select subscription from billing where workspace_id = ?", atomic.workspace), { subscription: null })
  equal((await apply(atomic.event)).kind, "applied")

  const lost = await fixture("lost_event")
  let acknowledgements = 0
  const lostAck: typeof Database.batch = async (callback) => {
    const result = await batch(callback)
    if (++acknowledgements === 2) throw new Error("lost acknowledgement")
    return result
  }
  await rejects(apply(lost.event, lostAck), /lost acknowledgement/)
  await run("update subscription set weekly_tokens = 11 where workspace_id = ?", lost.workspace)
  equal((await apply(lost.event)).kind, "duplicate")
  equal(await usage(lost.workspace), { count: 2, ids: 2, tokens: 22 })
  equal(await events(lost.checkout.invoiceID), { count: 1 })

  const changed = await fixture("changed_event")
  let snapshots = 0
  const stale: typeof Database.batch = async (callback) => {
    if (++snapshots === 2) await run("update payment_invoice set amount = 1 where id = ?", changed.checkout.invoiceID)
    return batch(callback)
  }
  await rejects(apply(changed.event, stale), /malformed JSON/)
  equal(await events(changed.checkout.invoiceID), { count: 0 })
  equal(await plans(changed.workspace), { count: 0 })
  equal(await state(changed.checkout.invoiceID), { checkout: "ready", invoice: "created" })

  for (const missing of ["billing", "user"] as const) {
    const item = await fixture(`missing_${missing}`)
    await run(
      missing === "billing"
        ? "delete from billing where workspace_id = ?"
        : "update user set time_deleted = ? where workspace_id = ?",
      ...(missing === "billing" ? [item.workspace] : [now, item.workspace]),
    )
    await rejects(apply(item.event), /malformed JSON/)
    equal(await events(item.checkout.invoiceID), { count: 0 })
    equal(await plans(item.workspace), { count: 0 })
    equal(await state(item.checkout.invoiceID), { checkout: "ready", invoice: "created" })
  }

  // Invoice recording itself also uses the production batch API; no interactive transaction fixture.
  const nextInput = {
    id: "inv_new_plan",
    workspaceID: ready.workspace,
    provider: "bonum" as const,
    merchantAccountID: "synthetic-bonum",
    externalInvoiceID: "new-plan",
    purpose: "subscription" as const,
    plan: "max" as const,
    amount: 99000,
  }
  equal((await native.recordPaymentInvoice(nextInput, { batch })).kind, "created")
  equal((await native.recordPaymentInvoice(nextInput, { batch })).kind, "duplicate")
  await rejects(native.recordPaymentInvoice({ ...nextInput, amount: 1 }, { batch }), /дахин илгээхэд/)
  const nextEvent = {
    ...ready.event,
    provider: "bonum" as const,
    merchantAccountID: "synthetic-bonum",
    externalEventID: "paid-new-plan",
    externalInvoiceID: "new-plan",
    externalPaymentID: "payment-new-plan",
    amount: 99000,
    occurredAt: now + 1000,
  }
  equal((await apply(nextEvent, batch, now + 1000)).kind, "applied")
  equal((await apply(refund, batch, now + 2000)).kind, "duplicate")
  equal(
    await row(
      "select json_extract(subscription,'$.invoiceID') invoice from billing where workspace_id = ?",
      ready.workspace,
    ),
    { invoice: "inv_new_plan" },
  )
  equal(await usage(ready.workspace), { count: 2, ids: 2, tokens: 0 })

  const extraInput = { ...nextInput, id: "inv_conflicting", externalInvoiceID: "conflicting-plan" }
  await native.recordPaymentInvoice(extraInput, { batch })
  const extra = {
    ...nextEvent,
    externalEventID: "paid-conflicting",
    externalInvoiceID: "conflicting-plan",
    externalPaymentID: "conflicting-payment",
  }
  await rejects(apply(extra, batch, now + 2000), /malformed JSON/)
  equal(await events("inv_conflicting"), { count: 0 })
  equal(await row("select status from payment_invoice where id = 'inv_conflicting'"), { status: "created" })
  equal(await plans(ready.workspace), { count: 2 })

  await run(
    "update billing set subscription = json_remove(subscription, '$.source') where workspace_id = ?",
    concurrent.workspace,
  )
  await rejects(native.expirePlanSubscriptions(end, 100, { batch: rollback }), /malformed JSON/)
  equal(await row("select status from plan_subscription where invoice_id = ?", concurrent.checkout.invoiceID), {
    status: "active",
  })
  equal(await native.expirePlanSubscriptions(end, 1, { batch }), 1)
  equal(await row("select count(*) count from plan_subscription where status = 'expired'"), { count: 1 })
  await native.expirePlanSubscriptions(end, 100, { batch })
  equal(await row("select status from plan_subscription where invoice_id = ?", concurrent.checkout.invoiceID), {
    status: "expired",
  })
  equal(await usage(concurrent.workspace), { count: 0, ids: 0, tokens: null })
  equal(await row("select subscription from billing where workspace_id = ?", concurrent.workspace), {
    subscription: null,
  })
  equal(await row("select status from plan_subscription where invoice_id = 'inv_new_plan'"), { status: "active" })
  equal(await native.expirePlanSubscriptions(end, 100, { batch }), 0)
  equal(native.addUtcCalendarMonths(now, 1), end)
  console.log(
    `SETTLEMENT_D1_RESULT ${JSON.stringify({ ok: true, checks, realMerchantCalls: 0, remoteBindings: false })}`,
  )
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Settlement persistence escaped temp root")
  await rm(persistTo, { recursive: true, force: true })
}
function equal(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected)
  checks++
}
async function rejects(promise: Promise<unknown>, expected: RegExp) {
  await assert.rejects(promise, expected)
  checks++
}
