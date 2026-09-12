import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { SupportService } from "../../app/src/routes/v1/support/support-handler"
import type { PlatformAdminContext } from "../../admin/src/lib/admin-context"

const native: typeof import("./fixtures/support-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-support-d1-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined
let checks = 0
const adminID = `adm_${"A".repeat(26)}`
const assigneeID = `adm_${"B".repeat(26)}`
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
  await run(
    "insert into platform_admin(id,email,role,status) values (?, 'synthetic-admin@example.test','support','active'), (?, 'synthetic-assignee@example.test','support','active')",
    adminID,
    assigneeID,
  )
  const seed = async (id: string) => {
    const accountID = `acc_${id}`
    await run("insert into account(id,status) values (?, 'active')", accountID)
    return {
      accountID,
      requesterEmail: `${id}@example.test`,
      subject: "Synthetic support request",
      category: "technical" as const,
      message: "Synthetic message token=synthetic-private-credential",
    }
  }
  const create = (input: Parameters<typeof native.createSupportTicket>[0], selectedBatch = batch) =>
    native.createSupportTicket(input, { batch: selectedBatch })
  const reply = (accountID: string, ticketID: string, version = 0, selectedBatch = batch) =>
    native.replyToSupportTicket(
      { accountID, ticketID, expectedLockVersion: version, message: "Synthetic reply" },
      { batch: selectedBatch },
    )
  const state = (ticketID: string) =>
    row(
      "select status,lock_version,priority,assigned_admin_id,last_message_at from support_ticket where id=?",
      ticketID,
    )
  const counts = (ticketID: string) =>
    row(
      "select (select count(*) from support_message where ticket_id=?) messages, (select count(*) from admin_audit_log where target_id=? and outcome='success') audits",
      ticketID,
      ticketID,
    )
  const doomed = (async (callback: Parameters<typeof Database.batch>[0]) => {
    const failure = db.select({ value: native.sql<number>`json_extract('invalid', '$')` }).from(native.sql`(select 1)`)
    return (await db.batch([...callback(db), failure])).slice(0, -1)
  }) as typeof Database.batch
  const onCall = (at: number, action: () => Promise<unknown>, lose = false): typeof Database.batch => {
    let calls = 0
    return async (callback) => {
      const selected = ++calls === at
      if (selected && !lose) await action()
      const result = await batch(callback)
      if (selected && lose) throw new Error("Synthetic lost acknowledgement")
      return result
    }
  }
  const firstInput = await seed("first")
  const first = await create(firstInput)
  equal(first.status, "open")
  equal(first.lockVersion, 0)
  equal(await counts(first.id), { messages: 1, audits: 0 })
  const detail = await native.getAccountSupportTicketWithDb(db, { accountID: firstInput.accountID, ticketID: first.id })
  equal(JSON.stringify(detail).includes("synthetic-private-credential"), false)
  equal(JSON.stringify(detail).includes("[НУУЦ ХАЛХЛАВ]"), true)
  await rejects(
    () => native.getAccountSupportTicketWithDb(db, { accountID: "acc_other", ticketID: first.id }),
    "not_found",
  )
  equal((await reply(firstInput.accountID, first.id)).lockVersion, 1)
  await rejects(() => reply(firstInput.accountID, first.id), "conflict")
  equal(await counts(first.id), { messages: 2, audits: 0 })

  const members = await seed("membership")
  await rejects(() => create({ ...members, workspaceID: "wrk_support" }), "membership")
  await run("insert into workspace(id,name) values ('wrk_support','Synthetic workspace')")
  await run(
    "insert into user(id,workspace_id,account_id,name,role) values ('usr_support','wrk_support',?,'Synthetic member','member')",
    members.accountID,
  )
  await rejects(
    () =>
      create(
        { ...members, workspaceID: "wrk_support" },
        onCall(1, () => run("update user set time_deleted=? where id='usr_support'", Date.now())),
      ),
    "membership",
  )
  equal(await row("select count(*) count from support_ticket where account_id=?", members.accountID), { count: 0 })
  const suspended = await seed("suspended")
  const suspendedTicket = await create(suspended)
  await rejects(
    () =>
      reply(
        suspended.accountID,
        suspendedTicket.id,
        0,
        onCall(2, () =>
          run(
            "update account set status='suspended',suspension_reason='Synthetic suspension',suspended_by=?,time_suspended=? where id=?",
            adminID,
            Date.now(),
            suspended.accountID,
          ),
        ),
      ),
    "suspended",
  )
  equal(await counts(suspendedTicket.id), { messages: 1, audits: 0 })
  await rejects(() => create(suspended), "suspended")
  await run("update account set time_deleted=? where id=?", Date.now(), suspended.accountID)
  await rejects(() => create(suspended), "not_found")

  const raceInput = await seed("create_race")
  const creates = await Promise.allSettled(Array.from({ length: 14 }, () => create(raceInput)))
  equal(creates.filter((value) => value.status === "fulfilled").length, 10)
  equal(creates.filter((value) => value.status === "rejected" && value.reason.code === "rate_limit").length, 4)
  equal(await row("select count(*) count from support_ticket where account_id=?", raceInput.accountID), { count: 10 })
  await run(
    "update support_ticket set status='resolved',time_resolved=? where account_id=?",
    Date.now(),
    raceInput.accountID,
  )
  equal(
    (await Promise.allSettled(Array.from({ length: 12 }, () => create(raceInput)))).filter(
      (value) => value.status === "fulfilled",
    ).length,
    10,
  )
  await run(
    "update support_ticket set status='resolved',time_resolved=? where account_id=?",
    Date.now(),
    raceInput.accountID,
  )
  await rejects(() => create(raceInput), "rate_limit")
  equal(await row("select count(*) count from support_message where account_id=?", raceInput.accountID), { count: 20 })

  const replyRaceInput = await seed("reply_race")
  const replyRace = await create(replyRaceInput)
  const replies = await Promise.allSettled(
    Array.from({ length: 8 }, () => reply(replyRaceInput.accountID, replyRace.id)),
  )
  equal(replies.filter((value) => value.status === "fulfilled").length, 1)
  equal(replies.filter((value) => value.status === "rejected" && value.reason.code === "conflict").length, 7)
  equal(await counts(replyRace.id), { messages: 2, audits: 0 })
  const atomicInput = await seed("atomic")
  await rejects(() => create(atomicInput, doomed))
  equal(await row("select count(*) count from support_ticket where account_id=?", atomicInput.accountID), { count: 0 })
  await run(
    "create trigger synthetic_support_message_failure before insert on support_message when NEW.account_id='acc_atomic' begin select raise(ABORT,'synthetic message failure'); end",
  )
  await rejects(() => create(atomicInput))
  equal(await row("select count(*) count from support_ticket where account_id=?", atomicInput.accountID), { count: 0 })
  await run("drop trigger synthetic_support_message_failure")
  const atomic = await create(
    atomicInput,
    onCall(1, async () => undefined, true),
  )
  equal(await counts(atomic.id), { messages: 1, audits: 0 })
  equal(
    (
      await reply(
        atomicInput.accountID,
        atomic.id,
        0,
        onCall(2, async () => undefined, true),
      )
    ).lockVersion,
    1,
  )
  equal(await counts(atomic.id), { messages: 2, audits: 0 })
  const beforeAtomic = await state(atomic.id)
  let atomicCalls = 0
  await rejects(() =>
    reply(atomicInput.accountID, atomic.id, 1, (callback) =>
      ++atomicCalls === 2 ? doomed(callback) : batch(callback),
    ),
  )
  equal(await state(atomic.id), beforeAtomic)
  equal(await counts(atomic.id), { messages: 2, audits: 0 })

  const manager: PlatformAdminContext = {
    id: adminID,
    email: "synthetic-admin@example.test",
    subject: "synthetic-support",
    role: "support",
    permissions: ["support.read", "support.manage"],
    requestID: "synthetic-request",
    bootstrapped: false,
  }
  const request = (origin = "https://admin.dev.mgpt.mn") =>
    new Request("https://admin.dev.mgpt.mn/support", {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    })
  const admin = (
    input: Parameters<typeof native.mutateAdminSupportTicket>[0],
    selectedBatch = batch,
    context = manager,
    currentRequest = request(),
    audit = native.adminAuditQuery,
  ) => {
    const { adminID: unused, ...raw } = input
    return native.mutateAdminSupport(context, currentRequest, raw, {
      batch: selectedBatch,
      mutateAdminSupportTicket: native.mutateAdminSupportTicket,
      adminAuditQuery: audit,
      writeAdminAudit: async (value) => {
        await batch((tx) => [native.adminAuditQuery(tx, value)])
      },
    })
  }
  const adminInput = await seed("admin")
  const adminTicket = await create(adminInput)
  const publicReply = {
    adminID,
    ticketID: adminTicket.id,
    operation: "reply" as const,
    expectedLockVersion: 0,
    message: "Synthetic public reply api_key=synthetic-private-value",
  }
  equal((await admin(publicReply)).ok, true)
  equal(await counts(adminTicket.id), { messages: 2, audits: 1 })
  const afterReply = await state(adminTicket.id)
  equal(
    (await admin({ ...publicReply, operation: "note", expectedLockVersion: 1, message: "Synthetic private note" })).ok,
    true,
  )
  equal((await state(adminTicket.id))?.last_message_at, afterReply?.last_message_at)
  equal(await counts(adminTicket.id), { messages: 3, audits: 2 })
  const customer = await native.getAccountSupportTicketWithDb(db, {
    accountID: adminInput.accountID,
    ticketID: adminTicket.id,
  })
  equal(customer.messages.length, 2)
  equal(JSON.stringify(customer).includes("Synthetic private note"), false)
  equal(JSON.stringify(customer).includes("synthetic-private-value"), false)
  equal(JSON.stringify(customer).includes("assigned_admin_id"), false)
  equal((await native.getAdminSupportTicketWithDb(db, { ticketID: adminTicket.id })).messages.length, 3)
  const auditRows = await binding
    .prepare("select metadata from admin_audit_log where target_id=? and outcome='success'")
    .bind(adminTicket.id)
    .all()
  equal(JSON.stringify(auditRows).includes("Synthetic public reply"), false)
  equal(JSON.stringify(auditRows).includes("synthetic-private-value"), false)
  equal(JSON.stringify(auditRows).includes("before_status"), true)

  const denied = { ...publicReply, expectedLockVersion: 2 }
  equal((await admin(denied, batch, { ...manager, permissions: ["support.read"] })).ok, false)
  equal((await admin(denied, batch, manager, request("https://attacker.example"))).ok, false)
  equal(await counts(adminTicket.id), { messages: 3, audits: 2 })
  equal(
    (
      await admin(
        denied,
        onCall(2, () => run("update platform_admin set role='finance' where id=?", adminID)),
      )
    ).ok,
    false,
  )
  equal(await counts(adminTicket.id), { messages: 3, audits: 2 })
  await run("update platform_admin set role='support' where id=?", adminID)
  const assign = {
    adminID,
    ticketID: adminTicket.id,
    operation: "update" as const,
    expectedLockVersion: 2,
    assignedAdminID: assigneeID,
  }
  equal(
    (
      await admin(
        assign,
        onCall(2, () => run("update platform_admin set time_deleted=? where id=?", Date.now(), assigneeID)),
      )
    ).ok,
    false,
  )
  equal((await state(adminTicket.id))?.assigned_admin_id, null)
  await run("update platform_admin set time_deleted=null where id=?", assigneeID)
  equal((await admin(assign)).ok, true)
  equal((await state(adminTicket.id))?.assigned_admin_id, assigneeID)

  const auditFailureInput = await seed("audit_failure")
  const auditFailureTicket = await create(auditFailureInput)
  const auditFailureReply = { ...publicReply, ticketID: auditFailureTicket.id }
  await run(
    "create trigger synthetic_support_audit_failure before insert on admin_audit_log when NEW.outcome='success' and NEW.target_type='support_ticket' begin select raise(ABORT,'synthetic audit failure'); end",
  )
  equal((await admin(auditFailureReply)).ok, false)
  equal(await counts(auditFailureTicket.id), { messages: 1, audits: 0 })
  equal((await state(auditFailureTicket.id))?.lock_version, 0)
  await run("drop trigger synthetic_support_audit_failure")
  equal(
    (
      await admin(
        auditFailureReply,
        onCall(2, async () => undefined, true),
      )
    ).ok,
    true,
  )
  equal(await counts(auditFailureTicket.id), { messages: 2, audits: 1 })
  const concurrentInput = await seed("admin_race")
  const concurrent = await create(concurrentInput)
  const results = await Promise.all(Array.from({ length: 6 }, () => admin({ ...publicReply, ticketID: concurrent.id })))
  equal(results.filter((value) => value.ok).length, 1)
  equal(await counts(concurrent.id), { messages: 2, audits: 1 })

  const webInput = await seed("http")
  const service: SupportService = {
    create: (input) => create(input),
    reply: (input) => native.replyToSupportTicket(input, { batch }),
    list: async () => {
      throw new Error("Not used in this mutation test")
    },
    detail: (input) => native.getAccountSupportTicketWithDb(db, input),
  }
  const web = {
    appUrl: "https://app.dev.mgpt.mn",
    authenticate: async () => ({
      status: "authenticated" as const,
      account: { id: webInput.accountID, email: webInput.requesterEmail },
    }),
    service,
  }
  const webRequest = (body: unknown) =>
    new Request("https://dev.mgpt.mn/v1/support", {
      method: "POST",
      headers: { origin: web.appUrl, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const response = await native.createTicketRequest(
    webRequest({ subject: "Synthetic HTTP support", category: "technical", message: "Synthetic browser request" }),
    web,
  )
  equal(response.status, 201)
  equal(response.headers.get("content-type")?.includes("application/json"), true)
  const created = (await response.json()) as { id: string; lockVersion: number }
  equal(created.lockVersion, 0)
  equal(await counts(created.id), { messages: 1, audits: 0 })
  equal(
    (
      await native.replyTicketRequest(
        webRequest({ message: "Synthetic HTTP reply", expectedLockVersion: 0 }),
        created.id,
        web,
      )
    ).status,
    200,
  )
  const conflict = await native.replyTicketRequest(
    webRequest({ message: "Synthetic stale reply", expectedLockVersion: 0 }),
    created.id,
    web,
  )
  equal(conflict.status, 409)
  equal(((await conflict.json()) as { error: string }).error, "conflict")
  equal(await counts(created.id), { messages: 2, audits: 0 })
  const dailyInput = await seed("daily_reply")
  const daily = await create(dailyInput)
  await run(
    "with recursive n(v) as (select 1 union all select v+1 from n where v<49) insert into support_message(id,ticket_id,author_type,account_id,body,internal,time_created) select 'spm_'||upper(hex(randomblob(13))),?,'customer',?,'Synthetic daily reply',0,? from n",
    daily.id,
    dailyInput.accountID,
    Date.now(),
  )
  await rejects(() => reply(dailyInput.accountID, daily.id), "rate_limit")
  equal(await counts(daily.id), { messages: 50, audits: 0 })
  equal((await state(daily.id))?.lock_version, 0)
  const fullInput = await seed("full_ticket")
  const full = await create(fullInput)
  await run(
    "with recursive n(v) as (select 1 union all select v+1 from n where v<199) insert into support_message(id,ticket_id,author_type,admin_id,body,internal,time_created) select 'spm_'||upper(hex(randomblob(13))),?,'admin',?,'Synthetic internal note',1,? from n",
    full.id,
    adminID,
    Date.now(),
  )
  await rejects(() => reply(fullInput.accountID, full.id), "rate_limit")
  equal((await admin({ ...publicReply, ticketID: full.id })).ok, false)
  equal((await admin({ ...publicReply, operation: "note", ticketID: full.id })).ok, false)
  equal(await counts(full.id), { messages: 200, audits: 0 })
  equal((await state(full.id))?.lock_version, 0)
  for (const mutation of ["deleted", "closed", "changed"]) {
    const input = await seed(`stale_${mutation}`)
    const ticket = await create(input)
    await rejects(
      () =>
        reply(
          input.accountID,
          ticket.id,
          0,
          onCall(2, () => {
            if (mutation === "deleted")
              return run("update support_ticket set time_deleted=? where id=?", Date.now(), ticket.id)
            if (mutation === "closed")
              return run(
                "update support_ticket set status='resolved',time_resolved=? where id=?",
                Date.now(),
                ticket.id,
              )
            return run("update support_ticket set priority='urgent' where id=?", ticket.id)
          }),
        ),
      mutation === "deleted" ? "not_found" : mutation === "closed" ? "closed" : "conflict",
    )
    equal(await counts(ticket.id), { messages: 1, audits: 0 })
  }
  const updateInput = await seed("uncertain_update")
  const updateTicket = await create(updateInput)
  const update = {
    adminID,
    ticketID: updateTicket.id,
    operation: "update" as const,
    expectedLockVersion: 0,
    priority: "high" as const,
  }
  // Without a message receipt, an uncertain update is not reported as confirmed success or retried.
  equal(
    (
      await admin(
        update,
        onCall(2, async () => undefined, true),
      )
    ).ok,
    false,
  )
  equal((await state(updateTicket.id))?.priority, "high")
  equal((await state(updateTicket.id))?.lock_version, 1)
  equal(await counts(updateTicket.id), { messages: 1, audits: 1 })
  equal((await admin(update)).ok, false)
  equal(await counts(updateTicket.id), { messages: 1, audits: 1 })
  console.log(`SUPPORT_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Support test escaped temp root")
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
