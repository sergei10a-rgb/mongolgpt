import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { PaymentQueueEvent } from "../src/payment-queue"
import type { PlatformAdminContext } from "../../admin/src/lib/admin-context"
import type { AdminPaymentRecoveryDependencies } from "../../admin/src/lib/admin-payment-recovery"

const native: typeof import("./fixtures/payment-recovery-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-recovery-d1-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined
let checks = 0
const now = Date.UTC(2026, 8, 12, 1)
const event = (id: string) =>
  native.createPaymentQueueEvent(
    {
      provider: "qpay",
      merchantAccountID: "synthetic-merchant",
      externalEventID: `event-${id}`,
      externalInvoiceID: `invoice-${id}`,
      externalPaymentID: `payment-${id}`,
      type: "paid",
      amount: 39000,
      currency: "MNT",
      payloadHash: "a".repeat(64),
      occurredAt: now,
    },
    now,
  )

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
  const rollback = (async (callback: Parameters<typeof Database.batch>[0]) => {
    const doomed = db.select({ value: native.sql<number>`json_extract('invalid', '$')` }).from(native.sql`(select 1)`)
    return (await db.batch([...callback(db), doomed])).slice(0, -1)
  }) as typeof Database.batch
  const record = (id: string) => native.recordPaymentDeadLetter({ body: event(id), now }, { batch })
  const state = (id: string) =>
    row(
      "select status,attempts,last_error_code,time_next_attempt,time_lease_expires,time_resolved from payment_recovery where id = ?",
      id,
    )
  const audits = (id: string, action: string) =>
    row("select count(*) count from admin_audit_log where target_id = ? and action = ?", id, action)
  // Keep scenarios isolated without deleting evidence: completed cases leave the retry candidate set.
  const archive = () => run("update payment_recovery set time_deleted = ? where time_deleted is null", now)
  const process = (
    apply: (message: PaymentQueueEvent) => Promise<unknown>,
    at = now,
    selectedBatch = batch,
    limit = 50,
  ) => native.processPaymentRecoveries({ now: at, limit }, { apply, batch: selectedBatch })
  const quiet = async () => undefined

  const first = await record("first")
  equal(first.changed, true)
  equal(await record("first"), { ...first, changed: false })
  equal(await audits(first.id, "payment_recovery.dead_lettered"), { count: 1 })
  await rejects(() =>
    native.recordPaymentDeadLetter(
      { body: { ...event("first"), event: { ...event("first").event, amount: 1 } }, now },
      { batch },
    ),
  )
  equal(await audits(first.id, "payment_recovery.dead_lettered"), { count: 1 })

  const secret = "synthetic-secret-never-store-this"
  const invalid = await native.recordPaymentDeadLetter({ body: { version: 2, secret }, now }, { batch })
  equal(invalid.status, "manual_review")
  equal(await row("select event from payment_recovery where id = ?", invalid.id), { event: null })
  equal(JSON.stringify(await binding.prepare("select * from admin_audit_log").all()).includes(secret), false)
  equal(JSON.stringify(await binding.prepare("select * from payment_recovery").all()).includes(secret), false)
  await rejects(() =>
    native.recordPaymentDeadLetter({ body: event("wrong-hash"), trustedMessageHash: "b".repeat(64), now }, { batch }),
  )

  await rejects(() => native.recordPaymentDeadLetter({ body: event("rollback"), now }, { batch: rollback }))
  equal(await row("select count(*) count from payment_recovery where external_event_id = 'event-rollback'"), {
    count: 0,
  })
  equal(await row("select count(*) count from admin_audit_log"), { count: 2 })
  const lost: typeof Database.batch = async (callback) => {
    await batch(callback)
    throw new Error("Synthetic lost ack")
  }
  await rejects(() => native.recordPaymentDeadLetter({ body: event("lost"), now }, { batch: lost }))
  const recovered = await record("lost")
  equal(recovered.changed, false)
  equal(await audits(recovered.id, "payment_recovery.dead_lettered"), { count: 1 })
  await archive()

  const race = await record("race")
  const barrier = Promise.withResolvers<void>()
  let reads = 0
  let applies = 0
  const synchronize = () => {
    let calls = 0
    const synchronized: typeof Database.batch = async (callback) => {
      const result = await batch(callback)
      if (++calls === 1) {
        if (++reads === 2) barrier.resolve()
        await barrier.promise
      }
      return result
    }
    return synchronized
  }
  const racing = await Promise.all([
    process(
      async () => {
        applies++
      },
      now,
      synchronize(),
    ),
    process(
      async () => {
        applies++
      },
      now,
      synchronize(),
    ),
  ])
  equal(applies, 1)
  equal(
    racing.reduce((sum, result) => sum + result.resolved, 0),
    1,
  )
  equal(
    racing.reduce((sum, result) => sum + result.skipped, 0),
    1,
  )
  equal(await audits(race.id, "payment_recovery.resolved"), { count: 1 })
  await archive()

  const lostClaim = await record("lost-claim")
  let claimBatches = 0
  let claimApplies = 0
  await rejects(() =>
    process(
      async () => {
        claimApplies++
      },
      now,
      (callback) => (++claimBatches === 2 ? lost(callback) : batch(callback)),
    ),
  )
  equal(claimApplies, 0)
  equal((await state(lostClaim.id))?.status, "processing")
  equal(
    (
      await process(
        async () => {
          claimApplies++
        },
        now + native.PAYMENT_RECOVERY_LEASE_MS + 1,
      )
    ).resolved,
    1,
  )
  equal(claimApplies, 1)
  await archive()

  const lostResolution = await record("lost-resolution")
  let resolutionBatches = 0
  equal(
    (await process(quiet, now, (callback) => (++resolutionBatches === 3 ? lost(callback) : batch(callback)))).skipped,
    1,
  )
  equal((await state(lostResolution.id))?.status, "resolved")
  equal(await audits(lostResolution.id, "payment_recovery.resolved"), { count: 1 })
  equal((await process(quiet)).resolved, 0)
  await archive()

  const failed = await record("backoff")
  let attempts = 0
  const failing = async () => {
    attempts++
    throw new Error("synthetic-provider-secret-must-not-persist")
  }
  let at = now
  for (let attempt = 1; attempt <= native.PAYMENT_RECOVERY_MAX_ATTEMPTS; attempt++) {
    const result = await process(failing, at)
    equal(attempts, attempt)
    if (attempt === native.PAYMENT_RECOVERY_MAX_ATTEMPTS) {
      equal(result.manualReview, 1)
      break
    }
    equal(result.retried, 1)
    const next = at + native.PAYMENT_RECOVERY_BASE_RETRY_MS * 2 ** (attempt - 1)
    equal((await state(failed.id))?.time_next_attempt, next)
    equal((await process(failing, next - 1)).retried, 0)
    equal(attempts, attempt)
    at = next
  }
  equal(await audits(failed.id, "payment_recovery.manual_review"), { count: 1 })
  equal(JSON.stringify(await state(failed.id)).includes("synthetic-provider-secret"), false)
  await archive()

  const exhausted = await record("exhausted")
  await run(
    "update payment_recovery set status='processing', attempts=6, time_next_attempt=null, time_lease_expires=? where id=?",
    now - 1,
    exhausted.id,
  )
  let exhaustedApply = 0
  equal(
    (
      await process(async () => {
        exhaustedApply++
      })
    ).manualReview,
    1,
  )
  equal(exhaustedApply, 0)
  equal((await state(exhausted.id))?.status, "manual_review")
  equal(await audits(exhausted.id, "payment_recovery.manual_review"), { count: 1 })
  await archive()

  for (const sameAttempt of [false, true]) {
    const lease = await record(sameAttempt ? "aba" : "lease")
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const oldWorker = process(async () => {
      started.resolve()
      await finish.promise
    })
    await started.promise
    const later = now + native.PAYMENT_RECOVERY_LEASE_MS + 1
    if (sameAttempt) {
      await run(
        "update payment_recovery set time_lease_expires=?, time_updated=? where id=?",
        later + native.PAYMENT_RECOVERY_LEASE_MS,
        later,
        lease.id,
      )
    } else equal((await process(quiet, later)).resolved, 1)
    finish.resolve()
    equal((await oldWorker).skipped, 1)
    equal((await state(lease.id))?.status, sameAttempt ? "processing" : "resolved")
    equal(await audits(lease.id, "payment_recovery.resolved"), { count: sameAttempt ? 0 : 1 })
    await archive()
  }

  const malformed = await record("malformed")
  await run("update payment_recovery set event = ? where id = ?", JSON.stringify({ version: 2 }), malformed.id)
  equal(
    (
      await process(async () => {
        throw new Error("invalid event must not be applied")
      })
    ).manualReview,
    1,
  )
  equal((await state(malformed.id))?.last_error_code, "stored_event_invalid")
  await rejects(() => native.retryPaymentRecovery({ recoveryID: malformed.id, now }, { batch }), {
    code: "invalid_event",
  })
  await archive()

  const limited = await record("limit-a")
  await record("limit-b")
  equal(await process(quiet, now, batch, 1), { resolved: 1, retried: 0, manualReview: 0, skipped: 0, truncated: true })
  equal((await process(quiet)).resolved, 1)
  equal((await process(quiet)).resolved, 0)
  await rejects(() => process(quiet, now, batch, 0))
  await rejects(() => native.retryPaymentRecovery({ recoveryID: limited.id, now }, { batch }), {
    code: "invalid_state",
  })
  await archive()

  await binding.batch([
    binding.prepare("insert into account(id) values ('acc_recovery')"),
    binding.prepare("insert into workspace(id,name) values ('wrk_recovery','Synthetic recovery')"),
    binding.prepare(
      "insert into user(id,workspace_id,account_id,role,name) values ('usr_recovery','wrk_recovery','acc_recovery','admin','Owner')",
    ),
    binding.prepare("insert into billing(id,workspace_id,balance) values ('bil_recovery','wrk_recovery',0)"),
  ])
  const checkout = await native.createSubscriptionCheckout(
    { workspaceID: "wrk_recovery", accountID: "acc_recovery", requestKey: randomUUID(), provider: "qpay", plan: "pro" },
    {
      batch,
      now: () => now,
      catalog: {
        basic: { label: "Basic", amount: 19000 },
        pro: { label: "Pro", amount: 39000 },
        max: { label: "Max", amount: 99000 },
      },
      adapter: {
        provider: "qpay",
        merchantAccountID: "synthetic-merchant",
        async createInvoice() {
          return {
            provider: "qpay",
            merchantAccountID: "synthetic-merchant",
            externalInvoiceID: "invoice-entitlement",
            deepLinks: [],
          }
        },
      },
    },
  )
  const entitlement = await record("entitlement")
  let batchCalls = 0
  const completionFailure: typeof Database.batch = (callback) =>
    ++batchCalls === 3 ? rollback(callback) : batch(callback)
  const apply = (message: PaymentQueueEvent) =>
    native.applyPaymentQueueEvent(message, native.createPlanSubscriptionPaymentBatchEffect({ now: () => now }), {
      batch,
    })
  equal((await process(apply, now, completionFailure)).retried, 1)
  equal(await row("select status from payment_invoice where id=?", checkout.invoiceID), { status: "paid" })
  equal(await audits(entitlement.id, "payment_recovery.resolved"), { count: 0 })
  await run("update subscription set weekly_tokens=7 where workspace_id='wrk_recovery'")
  equal((await process(apply, now + native.PAYMENT_RECOVERY_BASE_RETRY_MS)).resolved, 1)
  equal(
    await row("select count(*) count, sum(weekly_tokens) tokens from subscription where workspace_id='wrk_recovery'"),
    { count: 1, tokens: 7 },
  )
  equal(await row("select count(*) count from payment_event where invoice_id=?", checkout.invoiceID), { count: 1 })
  equal(await audits(entitlement.id, "payment_recovery.resolved"), { count: 1 })
  await archive()

  const manual = await record("manual")
  await run(
    "update payment_recovery set status='manual_review', attempts=6, last_error_code='payment_apply_failed', time_next_attempt=null where id=?",
    manual.id,
  )
  const context: PlatformAdminContext = {
    id: "adm_01K3ABCDEFGHJKMNPQRSTVWXYZ",
    email: "admin@mgpt.mn",
    subject: "synthetic",
    role: "administrator",
    permissions: ["payments.recover"],
    requestID: "test",
    bootstrapped: false,
  }
  const input = {
    recoveryID: manual.id,
    requestKey: randomUUID(),
    confirmation: "retry",
    reason: "Туршилтын сэргээх хүсэлтийг баталгаажуулж дахин дараалалд оруулна.",
  }
  const request = (origin = "https://admin.dev.mgpt.mn") =>
    new Request("https://admin.dev.mgpt.mn/billing/recovery", {
      method: "POST",
      headers: {
        origin,
        "sec-fetch-site": origin === "https://admin.dev.mgpt.mn" ? "same-origin" : "cross-site",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
    })
  const adminDependencies = (selectedBatch = batch): AdminPaymentRecoveryDependencies => ({
    batch: selectedBatch,
    retryPaymentRecovery: native.retryPaymentRecovery,
    adminAuditQuery: native.adminAuditQuery,
    async writeAdminAudit(audit) {
      await batch((db) => [native.adminAuditQuery(db, audit)])
    },
  })
  equal(
    (await native.retryAdminPaymentRecovery({ ...context, permissions: [] }, request(), input, adminDependencies())).ok,
    false,
  )
  equal(
    (await native.retryAdminPaymentRecovery(context, request("https://attacker.example"), input, adminDependencies()))
      .ok,
    false,
  )
  equal((await state(manual.id))?.status, "manual_review")
  equal(
    await row(
      "select count(*) count from admin_audit_log where target_id=? and outcome='denied' and json_extract(metadata,'$.reason')='forbidden'",
      manual.id,
    ),
    { count: 1 },
  )
  equal(
    await row(
      "select count(*) count from admin_audit_log where target_id=? and outcome='denied' and json_extract(metadata,'$.reason')='request_origin'",
      manual.id,
    ),
    { count: 1 },
  )
  let retryBatches = 0
  equal(
    (
      await native.retryAdminPaymentRecovery(
        context,
        request(),
        input,
        adminDependencies((callback) => (++retryBatches === 2 ? rollback(callback) : batch(callback))),
      )
    ).ok,
    false,
  )
  equal((await state(manual.id))?.status, "manual_review")
  equal(retryBatches, 2)
  equal(await row("select count(*) count from admin_audit_log where target_id=? and outcome='success'", manual.id), {
    count: 0,
  })
  equal((await native.retryAdminPaymentRecovery(context, request(), input, adminDependencies())).ok, true)
  equal((await state(manual.id))?.attempts, 0)
  equal((await state(manual.id))?.status, "pending")
  equal(await row("select count(*) count from admin_audit_log where target_id=? and outcome='success'", manual.id), {
    count: 1,
  })
  equal((await native.retryAdminPaymentRecovery(context, request(), input, adminDependencies())).ok, false)
  equal(await row("select count(*) count from admin_audit_log where target_id=? and outcome='success'", manual.id), {
    count: 1,
  })

  equal(
    await row(
      "select actor_email, json_extract(metadata,'$.before_status') before_status, json_extract(metadata,'$.previous_attempts') previous_attempts from admin_audit_log where target_id=? and outcome='success'",
      manual.id,
    ),
    { actor_email: context.email, before_status: "manual_review", previous_attempts: 6 },
  )
  const staleRetry = await record("stale-retry")
  await run(
    "update payment_recovery set status='manual_review', attempts=6, last_error_code='payment_apply_failed', time_next_attempt=null where id=?",
    staleRetry.id,
  )
  let staleBatches = 0
  await rejects(() =>
    native.retryPaymentRecovery(
      { recoveryID: staleRetry.id, now },
      {
        batch: async (callback) => {
          if (++staleBatches === 2)
            await run(
              "update payment_recovery set event=? where id=?",
              JSON.stringify(event("changed-event")),
              staleRetry.id,
            )
          return batch(callback)
        },
        effect: (db) => [
          native.adminAuditQuery(db, {
            actorEmail: context.email,
            action: "payment_recovery.retry",
            outcome: "success",
            request: request(),
            targetID: staleRetry.id,
          }),
        ],
      },
    ),
  )
  equal((await state(staleRetry.id))?.status, "manual_review")
  equal((await state(staleRetry.id))?.attempts, 6)
  equal(await audits(staleRetry.id, "payment_recovery.retry"), { count: 0 })

  console.log(`RECOVERY_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Recovery test escaped temp root")
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
