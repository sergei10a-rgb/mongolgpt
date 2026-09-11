import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { PaymentCancellationAdapter, PaymentRefundAdapter, VerifiedPaymentEvent } from "../src/payment-provider"

const native: typeof import("./fixtures/payment-operations-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-payment-operations-d1-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined
let checks = 0
const now = Date.UTC(2026, 8, 12, 1)
type Operation = "cancellation" | "refund"

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
  const apply = (event: VerifiedPaymentEvent) =>
    native.applyPaymentQueueEvent(
      native.createPaymentQueueEvent(event, now),
      native.createPlanSubscriptionPaymentBatchEffect({ now: () => now }),
      { batch },
    )
  const rollback = (async (callback: Parameters<typeof Database.batch>[0]) => {
    const doomed = db.select({ value: native.sql<number>`json_extract('invalid', '$')` }).from(native.sql`(select 1)`)
    return (await db.batch([...callback(db), doomed])).slice(0, -1)
  }) as typeof Database.batch
  function intercept(at: number[], action: (callback: Parameters<typeof Database.batch>[0]) => Promise<unknown>) {
    let calls = 0
    return (async (callback: Parameters<typeof Database.batch>[0]) => {
      calls++
      if (at.includes(calls)) return action(callback)
      return batch(callback)
    }) as typeof Database.batch
  }
  const lost = async (callback: Parameters<typeof Database.batch>[0]) => {
    await batch(callback)
    throw new Error("Synthetic lost commit acknowledgement")
  }
  async function fixture(
    kind: Operation,
    id: string,
    provider: "qpay" | "bonum" = "qpay",
    owner?: { workspaceID: string; accountID: string },
  ) {
    const workspaceID = owner?.workspaceID ?? `wrk_${id}`
    const accountID = owner?.accountID ?? `acc_${id}`
    const table = kind === "cancellation" ? "payment_cancellation" : "payment_refund"
    const count = { mutations: 0, reconciliations: 0 }
    if (!owner)
      await binding.batch([
        binding.prepare("insert into account (id) values (?)").bind(accountID),
        binding.prepare("insert into workspace (id,name) values (?, 'Synthetic payment')").bind(workspaceID),
        binding
          .prepare("insert into user (id,workspace_id,account_id,role,name) values (?,?,?,'admin','Owner')")
          .bind(`usr_${id}`, workspaceID, accountID),
        binding.prepare("insert into billing (id,workspace_id,balance) values (?,?,0)").bind(`bil_${id}`, workspaceID),
      ])
    const receipt = () => ({
      provider,
      merchantAccountID: "synthetic-merchant",
      externalInvoiceID: `external-${id}`,
      externalPaymentID: `payment-${id}`,
      amount: 49000,
      currency: "MNT" as const,
      providerPayloadHash: "b".repeat(64),
    })
    const adapter: PaymentCancellationAdapter & PaymentRefundAdapter = {
      provider,
      merchantAccountID: "synthetic-merchant",
      async createInvoice() {
        return { provider, merchantAccountID: "synthetic-merchant", externalInvoiceID: `external-${id}`, deepLinks: [] }
      },
      async cancelInvoice() {
        count.mutations++
        equal(await row(`select status from ${table} where invoice_id = ?`, checkout.invoiceID), {
          status: "requested",
        })
        return receipt()
      },
      async refundPayment() {
        count.mutations++
        equal(await row(`select status from ${table} where invoice_id = ?`, checkout.invoiceID), {
          status: "requested",
        })
        return receipt()
      },
      async reconcileRefund() {
        count.reconciliations++
        return undefined
      },
    }
    const checkout = await native.createSubscriptionCheckout(
      { workspaceID, accountID, requestKey: randomUUID(), provider, plan: "pro" },
      {
        batch,
        adapter,
        catalog: {
          basic: { label: "Basic", amount: 19000 },
          pro: { label: "Pro", amount: 49000 },
          max: { label: "Max", amount: 99000 },
        },
        now: () => now,
      },
    )
    if (kind === "refund")
      await apply({
        provider,
        merchantAccountID: "synthetic-merchant",
        externalInvoiceID: `external-${id}`,
        externalPaymentID: `payment-${id}`,
        amount: 49000,
        currency: "MNT",
        externalEventID: `paid-${id}`,
        type: "paid",
        payloadHash: "a".repeat(64),
        occurredAt: now,
      })
    const requestKey = randomUUID()
    return {
      accountID,
      workspaceID,
      checkout,
      adapter,
      count,
      receipt,
      requestKey,
      table,
      state: () =>
        row(`select status, error_code, time_completed from ${table} where invoice_id = ?`, checkout.invoiceID),
      call: (selectedBatch = batch, at = now, key = requestKey) =>
        kind === "cancellation"
          ? native.cancelSubscriptionCheckout(
              { workspaceID, accountID, invoiceID: checkout.invoiceID, requestKey: key },
              { batch: selectedBatch, adapters: { [provider]: adapter }, now: () => at },
            )
          : native.refundPlatformAdminSubscriptionPayment(
              {
                invoiceID: checkout.invoiceID,
                requestKey: key,
                reason: "Туршилтын баталгаажсан төлбөрийг буцаах хүсэлт",
              },
              { batch: selectedBatch, adapters: { [provider]: adapter }, now: () => at },
            ),
    }
  }

  for (const kind of ["cancellation", "refund"] as const) {
    const prefix = kind === "cancellation" ? "c" : "r"
    const terminal = kind === "cancellation" ? "cancelled" : "refunded"
    const normal = await fixture(kind, `${prefix}_normal`)
    const first = await normal.call()
    equal(first.result.status, terminal)
    equal(normal.count.mutations, 1)
    equal(await normal.state(), { status: terminal, error_code: null, time_completed: now })
    equal(await row("select status from payment_invoice where id = ?", normal.checkout.invoiceID), {
      status: kind === "cancellation" ? "created" : "paid",
    })
    equal((await apply(first.event!)).kind, "applied")
    equal(await row("select status from payment_checkout where id = ?", normal.checkout.invoiceID), {
      status: terminal,
    })
    equal((await normal.call(batch, now, randomUUID())).event, first.event)
    equal((await apply(first.event!)).kind, "duplicate")
    equal(normal.count.mutations, 1)
    equal(await row("select count(*) count from subscription where workspace_id = ?", normal.workspaceID), { count: 0 })

    const reusedKey = await fixture(kind, `${prefix}_key`, "qpay", normal)
    await rejects(() => reusedKey.call(batch, now, normal.requestKey))
    equal(reusedKey.count.mutations, 0)
    equal(await reusedKey.state(), null)
    equal((await reusedKey.call()).result.status, terminal)
    equal(reusedKey.count.mutations, 1)

    const race = await fixture(kind, `${prefix}_race`)
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => race.call()))
    equal(
      results.some((item) => item.status === "fulfilled"),
      true,
    )
    equal(race.count.mutations, 1)
    equal((await race.call()).result.status, terminal)
    equal(await row(`select count(*) count from ${race.table} where invoice_id = ?`, race.checkout.invoiceID), {
      count: 1,
    })

    const failedReservation = await fixture(kind, `${prefix}_rollback`)
    await rejects(() => failedReservation.call(intercept([2], rollback)))
    equal(failedReservation.count.mutations, 0)
    equal(await failedReservation.state(), null)
    equal((await failedReservation.call()).result.status, terminal)
    equal(failedReservation.count.mutations, 1)

    const missingAck = await fixture(kind, `${prefix}_lost_reserve`)
    await rejects(() => missingAck.call(intercept([2], lost)))
    equal(missingAck.count.mutations, 0)
    equal(await missingAck.state(), { status: "requested", error_code: null, time_completed: null })
    await rejects(() => missingAck.call(), { state: "request_in_progress" })
    await rejects(() => missingAck.call(batch, now + 120001), { state: "result_unknown" })
    equal(await missingAck.state(), { status: "unknown", error_code: "provider_result_unknown", time_completed: null })
    equal(missingAck.count.mutations, 0)

    const lostCompletion = await fixture(kind, `${prefix}_lost_complete`)
    equal((await lostCompletion.call(intercept([3], lost))).result.status, terminal)
    equal(lostCompletion.count.mutations, 1)
    equal(await lostCompletion.state(), { status: terminal, error_code: null, time_completed: now })

    const lostTwice = await fixture(kind, `${prefix}_lost_twice`)
    await rejects(() => lostTwice.call(intercept([3, 4], lost)), { state: "unknown", code: "persistence_failed" })
    equal(await lostTwice.state(), { status: terminal, error_code: null, time_completed: now })
    equal((await lostTwice.call()).result.status, terminal)
    equal(lostTwice.count.mutations, 1)

    const outage = await fixture(kind, `${prefix}_outage`)
    await rejects(() => outage.call(intercept([3, 4], rollback)), { state: "unknown", code: "persistence_failed" })
    equal(outage.count.mutations, 1)
    equal(await outage.state(), { status: "unknown", error_code: "persistence_failed", time_completed: null })
    if (kind === "refund") {
      outage.adapter.reconcileRefund = async () => {
        outage.count.reconciliations++
        return outage.receipt()
      }
      equal((await outage.call()).result.status, terminal)
      equal(outage.count.reconciliations, 1)
      equal((await outage.call()).result.status, terminal)
      equal(outage.count.reconciliations, 1)
    } else await rejects(() => outage.call(), { state: "result_unknown" })
    equal(outage.count.mutations, 1)

    const changed = await fixture(kind, `${prefix}_changed`)
    await rejects(() =>
      changed.call(
        intercept([2], async (callback) => {
          await run(
            "update payment_invoice set status = ? where id = ?",
            kind === "cancellation" ? "paid" : "refunded",
            changed.checkout.invoiceID,
          )
          return batch(callback)
        }),
      ),
    )
    equal(changed.count.mutations, 0)
    equal(await changed.state(), null)

    const mutatedScope = await fixture(kind, `${prefix}_mutated`)
    await rejects(() =>
      mutatedScope.call(
        intercept([2], async (callback) => {
          await binding.batch([
            binding
              .prepare("update payment_checkout set merchant_account_id = 'other-merchant' where id = ?")
              .bind(mutatedScope.checkout.invoiceID),
            binding
              .prepare("update payment_invoice set merchant_account_id = 'other-merchant' where id = ?")
              .bind(mutatedScope.checkout.invoiceID),
          ])
          return batch(callback)
        }),
      ),
    )
    equal(mutatedScope.count.mutations, 0)
    equal(await mutatedScope.state(), null)

    const deleted = await fixture(kind, `${prefix}_deleted`)
    await run("update payment_invoice set time_deleted = ? where id = ?", now, deleted.checkout.invoiceID)
    await rejects(() => deleted.call())
    equal(deleted.count.mutations, 0)
    equal(await deleted.state(), null)

    const wrongScope = await fixture(kind, `${prefix}_scope`)
    await run(
      "update payment_invoice set merchant_account_id = 'foreign-merchant' where id = ?",
      wrongScope.checkout.invoiceID,
    )
    await rejects(() => wrongScope.call())
    equal(wrongScope.count.mutations, 0)

    const mismatch = await fixture(kind, `${prefix}_receipt`)
    if (kind === "cancellation")
      mismatch.adapter.cancelInvoice = async () => {
        mismatch.count.mutations++
        return { ...mismatch.receipt(), externalInvoiceID: "other-invoice" }
      }
    else
      mismatch.adapter.refundPayment = async () => {
        mismatch.count.mutations++
        return { ...mismatch.receipt(), amount: 1 }
      }
    await rejects(() => mismatch.call(), { state: "unknown", code: "persistence_failed" })
    equal(await mismatch.state(), { status: "unknown", error_code: "persistence_failed", time_completed: null })
    await rejects(() => mismatch.call(), { state: "result_unknown" })
    equal(mismatch.count.mutations, 1)

    const unsupported = await fixture(kind, `${prefix}_bonum`, "bonum")
    await rejects(() => unsupported.call(), { provider: "bonum" })
    equal(unsupported.count.mutations, 0)
    equal(await unsupported.state(), null)

    const providerFailure = await fixture(kind, `${prefix}_failure`)
    const fail = async () => {
      providerFailure.count.mutations++
      throw new Error("Synthetic provider timeout")
    }
    providerFailure.adapter.cancelInvoice = fail
    providerFailure.adapter.refundPayment = fail
    await rejects(() => providerFailure.call(), { state: "unknown", code: "provider_uncertain" })
    await rejects(() => providerFailure.call(), { state: "result_unknown" })
    equal(providerFailure.count.mutations, 1)
  }

  const latePayment = await fixture("cancellation", "late_payment")
  latePayment.adapter.cancelInvoice = async () => {
    latePayment.count.mutations++
    await apply({
      provider: "qpay",
      merchantAccountID: "synthetic-merchant",
      externalInvoiceID: latePayment.receipt().externalInvoiceID,
      externalPaymentID: latePayment.receipt().externalPaymentID,
      externalEventID: "paid-during-cancellation",
      amount: 49000,
      currency: "MNT",
      type: "paid",
      payloadHash: "a".repeat(64),
      occurredAt: now,
    })
    return latePayment.receipt()
  }
  const lateCancellation = await latePayment.call()
  equal((await apply(lateCancellation.event!)).kind, "rejected")
  equal(await row("select status from payment_invoice where id = ?", latePayment.checkout.invoiceID), {
    status: "paid",
  })
  equal(await row("select count(*) count from subscription where workspace_id = ?", latePayment.workspaceID), {
    count: 1,
  })
  await rejects(() => latePayment.call(), { state: "settled" })
  equal(latePayment.count.mutations, 1)

  const auth = await fixture("cancellation", "auth")
  await run("update user set role = 'member' where workspace_id = ?", auth.workspaceID)
  await rejects(() => auth.call(), { name: "PaymentCancellationAuthorizationError" })
  equal(auth.count.mutations, 0)
  equal(await auth.state(), null)
  await run("update user set role = 'admin' where workspace_id = ?", auth.workspaceID)
  await rejects(() =>
    auth.call(
      intercept([2], async (callback) => {
        await run("update user set time_deleted = ? where workspace_id = ?", now, auth.workspaceID)
        return batch(callback)
      }),
    ),
  )
  equal(auth.count.mutations, 0)
  equal(await auth.state(), null)

  const foreign = await fixture("cancellation", "foreign")
  await rejects(() =>
    native.cancelSubscriptionCheckout(
      {
        accountID: foreign.accountID,
        workspaceID: foreign.workspaceID,
        invoiceID: auth.checkout.invoiceID,
        requestKey: randomUUID(),
      },
      { adapters: { qpay: foreign.adapter }, batch, now: () => now },
    ),
  )
  equal(foreign.count.mutations, 0)
  equal(await auth.state(), null)

  const platformAdmin = await fixture("cancellation", "platform")
  equal(
    (
      await native.cancelPlatformAdminSubscriptionCheckout(
        {
          invoiceID: platformAdmin.checkout.invoiceID,
          requestKey: randomUUID(),
          reason: "Туршилтын нэхэмжлэхийг цуцлах баталгаажсан хүсэлт",
        },
        { batch, adapters: { qpay: platformAdmin.adapter }, now: () => now },
      )
    ).result.status,
    "cancelled",
  )
  equal(
    await row(
      "select account_id,workspace_id from payment_cancellation where invoice_id = ?",
      platformAdmin.checkout.invoiceID,
    ),
    { account_id: platformAdmin.accountID, workspace_id: platformAdmin.workspaceID },
  )

  console.log(`OPERATIONS_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Payment operations test escaped temp root")
  await rm(persistTo, { recursive: true, force: true })
}

function equal(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected)
  checks++
}
async function rejects(action: () => Promise<unknown>, expected?: Record<string, unknown>) {
  await assert.rejects(action, expected ?? Error)
  checks++
}
