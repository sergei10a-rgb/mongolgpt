import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { AdminAccessConfig } from "../../admin/src/lib/access"

const native: typeof import("./fixtures/admin-auth-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-admin-auth-d1-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined
let checks = 0
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
  const config: AdminAccessConfig = {
    teamDomain: "https://synthetic.cloudflareaccess.com",
    audience: "synthetic-audience",
    bootstrapEmails: new Set(),
  }
  const request = new Request("https://admin.dev.example.test/api/users?token=synthetic-private-value", {
    headers: { "cf-ray": "synthetic-request", "cf-connecting-ip": "192.0.2.1", "user-agent": "Synthetic QA" },
  })
  const authorize = (email: string, subject = `subject:${email}`, selectedBatch = batch) =>
    native.authorizePlatformAdmin({ email, subject, expiresAt: Math.floor(Date.now() / 1000) + 300 }, config, request, {
      batch: selectedBatch,
    })
  const state = (email: string) => row("select * from platform_admin where email=?", email)
  const audits = (email: string, action = "admin.bootstrap_owner") =>
    row("select count(*) count from admin_audit_log where actor_email=? and action=?", email, action)
  const seed = (email: string, role = "support", subject: string | null = null) =>
    run(
      "insert into platform_admin(id,email,role,status,access_subject) values (?,?,?,'active',?)",
      `adm_${email.split("@")[0]}`,
      email,
      role,
      subject,
    )
  const reset = async (...emails: string[]) => {
    // Only this isolated temporary database is reset; immutable audit receipts remain for every scenario.
    await run("delete from platform_admin")
    config.bootstrapEmails = new Set(emails)
  }
  const beforeBatch = (action: () => Promise<unknown>): typeof Database.batch => {
    let first = true
    return async (callback) => {
      if (first) {
        first = false
        await action()
      }
      return batch(callback)
    }
  }
  const doomed = (async (callback: Parameters<typeof Database.batch>[0]) => {
    const failure = db.select({ value: native.sql<number>`json_extract('invalid', '$')` }).from(native.sql`(select 1)`)
    return (await db.batch([...callback(db), failure])).slice(0, -1)
  }) as typeof Database.batch

  await rejects(() => authorize("unlisted@example.test"), "not_registered")
  equal(await state("unlisted@example.test"), null)
  equal(await audits("unlisted@example.test", "admin.authorization"), { count: 1 })
  equal(
    await row(
      "select target_id,metadata,source_ip,request_id from admin_audit_log where actor_email='unlisted@example.test'",
    ),
    {
      target_id: "GET /api/users",
      metadata: '{"reason":"not_registered"}',
      source_ip: "192.0.2.1",
      request_id: "synthetic-request",
    },
  )
  equal(JSON.stringify(await row("select * from admin_audit_log limit 1")).includes("synthetic-private-value"), false)

  await reset("owner@example.test")
  const owner = await authorize("owner@example.test")
  equal(owner.role, "owner")
  equal(owner.bootstrapped, true)
  equal(owner.requestID, "synthetic-request")
  equal(owner.subject, "subject:owner@example.test")
  equal(owner.permissions.includes("admins.manage"), true)
  equal(await audits(owner.email), { count: 1 })
  equal((await state(owner.email))?.access_subject, owner.subject)
  equal((await authorize(owner.email)).bootstrapped, false)
  equal(await audits(owner.email), { count: 1 })
  config.bootstrapEmails = new Set(["second-owner@example.test"])
  await rejects(() => authorize("second-owner@example.test"), "not_registered")
  equal(await state("second-owner@example.test"), null)

  await reset("same-owner@example.test")
  const sameOwner = await Promise.all(Array.from({ length: 8 }, () => authorize("same-owner@example.test")))
  equal(new Set(sameOwner.map((admin) => admin.id)).size, 1)
  equal(sameOwner.filter((admin) => admin.bootstrapped).length, 1)
  equal(
    sameOwner.every((admin) => admin.role === "owner"),
    true,
  )
  equal(await audits("same-owner@example.test"), { count: 1 })

  await reset("competing-a@example.test", "competing-b@example.test")
  const competing = await Promise.allSettled([
    authorize("competing-a@example.test"),
    authorize("competing-b@example.test"),
  ])
  equal(competing.filter((value) => value.status === "fulfilled").length, 1)
  equal(competing.filter((value) => value.status === "rejected" && value.reason.code === "not_registered").length, 1)
  equal(await row("select count(*) count from platform_admin"), { count: 1 })
  equal(
    await row(
      "select count(*) count from admin_audit_log where actor_email like 'competing-%' and action='admin.bootstrap_owner'",
    ),
    { count: 1 },
  )

  await reset("subject-race@example.test")
  const subjects = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => authorize("subject-race@example.test", `subject-${i}`)),
  )
  equal(subjects.filter((value) => value.status === "fulfilled").length, 1)
  equal(subjects.filter((value) => value.status === "rejected" && value.reason.code === "subject_mismatch").length, 7)
  const winningSubject = subjects.find((value) => value.status === "fulfilled")
  assert.ok(winningSubject?.status === "fulfilled")
  equal((await state("subject-race@example.test"))?.access_subject, winningSubject.value.subject)
  equal(await audits("subject-race@example.test"), { count: 1 })
  equal(await audits("subject-race@example.test", "admin.authorization"), { count: 7 })

  await reset("deleted-owner@example.test", "replacement@example.test")
  await seed("deleted-owner@example.test", "owner", "deleted-subject")
  await run("update platform_admin set time_deleted=?", Date.now())
  await rejects(() => authorize("deleted-owner@example.test", "deleted-subject"), "not_registered")
  await rejects(() => authorize("replacement@example.test"), "not_registered")
  equal(await row("select count(*) count from platform_admin"), { count: 1 })
  equal(await audits("replacement@example.test"), { count: 0 })

  await reset("rollback@example.test")
  await rejects(() => authorize("rollback@example.test", "rollback-subject", doomed))
  equal(await state("rollback@example.test"), null)
  equal(await audits("rollback@example.test"), { count: 0 })
  await run(
    "create trigger synthetic_bootstrap_audit_failure before insert on admin_audit_log when NEW.action='admin.bootstrap_owner' begin select raise(ABORT,'synthetic audit failure'); end",
  )
  await rejects(() => authorize("rollback@example.test"))
  equal(await state("rollback@example.test"), null)
  equal(await audits("rollback@example.test"), { count: 0 })
  await run("drop trigger synthetic_bootstrap_audit_failure")
  equal((await authorize("rollback@example.test")).bootstrapped, true)

  await reset("lost-ack@example.test")
  let lostAckCalls = 0
  const lostAck: typeof Database.batch = async (callback) => {
    lostAckCalls++
    await batch(callback)
    throw new Error("Synthetic lost acknowledgement")
  }
  // An ambiguous write never authorizes or retries automatically. A subsequent fresh request can safely log in.
  await rejects(() => authorize("lost-ack@example.test", "lost-subject", lostAck))
  equal(lostAckCalls, 1)
  equal(await audits("lost-ack@example.test"), { count: 1 })
  equal((await authorize("lost-ack@example.test", "lost-subject")).bootstrapped, false)
  equal(await audits("lost-ack@example.test"), { count: 1 })

  await reset()
  for (const role of ["owner", "administrator", "support", "finance", "operations"]) {
    const email = `role-${role}@example.test`
    await seed(email, role)
    const context = await authorize(email)
    equal(context.role, role)
    equal(context.bootstrapped, false)
    equal(context.permissions.includes("admins.manage"), role === "owner")
    equal(context.permissions.includes("payments.refund"), ["owner", "administrator"].includes(role))
    equal(context.permissions.includes("support.manage"), ["owner", "administrator", "support"].includes(role))
    equal((await state(email))?.access_subject, `subject:${email}`)
    equal(await audits(email), { count: 0 })
  }
  await rejects(() => seed("invalid-role@example.test", "member"))
  equal(await state("invalid-role@example.test"), null)

  await seed("binding-race@example.test")
  const bindings = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => authorize("binding-race@example.test", `binding-${i}`)),
  )
  equal(bindings.filter((value) => value.status === "fulfilled").length, 1)
  equal(bindings.filter((value) => value.status === "rejected" && value.reason.code === "subject_mismatch").length, 7)
  const bound = bindings.find((value) => value.status === "fulfilled")
  assert.ok(bound?.status === "fulfilled")
  equal((await state("binding-race@example.test"))?.access_subject, bound.value.subject)
  equal(await audits("binding-race@example.test"), { count: 0 })

  await seed("empty-subject@example.test", "finance", "")
  equal((await authorize("empty-subject@example.test")).role, "finance")
  await seed("binding-rollback@example.test")
  const beforeRollback = await state("binding-rollback@example.test")
  await rejects(() => authorize("binding-rollback@example.test", "never-bound", doomed))
  equal(await state("binding-rollback@example.test"), beforeRollback)
  await seed("subject-holder@example.test", "finance", "unique-subject")
  await seed("subject-thief@example.test")
  const beforeCollision = await state("subject-thief@example.test")
  await rejects(() => authorize("subject-thief@example.test", "unique-subject"))
  equal(await state("subject-thief@example.test"), beforeCollision)
  equal((await state("subject-holder@example.test"))?.access_subject, "unique-subject")

  for (const mutation of ["suspended", "deleted", "subject", "role"]) {
    const email = `live-${mutation}@example.test`
    const subject = `original-${mutation}`
    await seed(email, "owner", subject)
    const selectedBatch = beforeBatch(async () => {
      if (mutation === "suspended") return run("update platform_admin set status='suspended' where email=?", email)
      if (mutation === "deleted")
        return run("update platform_admin set time_deleted=? where email=?", Date.now(), email)
      if (mutation === "subject")
        return run("update platform_admin set access_subject='changed-subject' where email=?", email)
      return run("update platform_admin set role='finance' where email=?", email)
    })
    if (mutation === "role") {
      const changed = await authorize(email, subject, selectedBatch)
      equal(changed.role, "finance")
      equal(changed.permissions.includes("admins.manage"), false)
      equal(changed.permissions.includes("payments.refund"), false)
      continue
    }
    await rejects(
      () => authorize(email, subject, selectedBatch),
      mutation === "suspended" ? "suspended" : mutation === "deleted" ? "not_registered" : "subject_mismatch",
    )
    equal((await state(email))?.time_last_seen, null)
    equal((await state(email))?.access_subject, mutation === "subject" ? "changed-subject" : subject)
    equal(await audits(email, "admin.authorization"), { count: 1 })
  }
  await seed("monotonic@example.test")
  const future = Date.now() + 86400000
  await run(
    "update platform_admin set time_last_seen=?,time_updated=? where email='monotonic@example.test'",
    future,
    future,
  )
  equal((await authorize("monotonic@example.test")).role, "support")
  equal((await state("monotonic@example.test"))?.time_last_seen, future)
  equal((await state("monotonic@example.test"))?.time_updated, future)

  await run(
    "create trigger synthetic_denial_audit_failure before insert on admin_audit_log when NEW.actor_email='denial-failure@example.test' begin select raise(ABORT,'synthetic denial failure'); end",
  )
  await rejects(() => authorize("denial-failure@example.test"))
  equal(await state("denial-failure@example.test"), null)
  equal(await audits("denial-failure@example.test", "admin.authorization"), { count: 0 })
  await run("drop trigger synthetic_denial_audit_failure")

  const audit = {
    actorEmail: "conditional-audit@example.test",
    action: "synthetic.conditional",
    outcome: "success" as const,
    request,
    metadata: { safe: "Монгол", count: 1, flag: true, empty: null },
  }
  await batch((tx) => [native.adminAuditQuery(tx, audit, native.sql`0 = 1`)])
  equal(await audits(audit.actorEmail, audit.action), { count: 0 })
  await batch((tx) => [native.adminAuditQuery(tx, audit, native.sql`1 = 1`)])
  equal(await audits(audit.actorEmail, audit.action), { count: 1 })
  const storedAudit = await row("select * from admin_audit_log where actor_email=?", audit.actorEmail)
  equal(JSON.parse(String(storedAudit?.metadata)), audit.metadata)
  equal(storedAudit?.admin_id, null)
  equal(storedAudit?.target_id, null)
  equal(storedAudit?.request_id, "synthetic-request")
  equal(storedAudit?.user_agent, "Synthetic QA")
  equal(typeof storedAudit?.time_created, "number")
  await rejects(() => run("update admin_audit_log set action='tampered' where id=?", String(storedAudit?.id)))
  await rejects(() => run("delete from admin_audit_log where id=?", String(storedAudit?.id)))
  console.log(`ADMIN_AUTH_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Admin auth test escaped temp root")
  await rm(persistTo, { recursive: true, force: true })
}
function equal(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected)
  checks++
}
async function rejects(action: () => Promise<unknown>, code?: string) {
  if (code)
    await assert.rejects(
      action,
      (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code,
    )
  else await assert.rejects(action)
  checks++
}
