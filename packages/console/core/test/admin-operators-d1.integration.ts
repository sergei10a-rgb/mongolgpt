import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { PlatformAdminContext } from "../../admin/src/lib/admin-context"

const native: typeof import("./fixtures/admin-operators-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-admin-operators-d1-"))
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
  const owner: PlatformAdminContext = {
    id: `adm_${"A".repeat(26)}`,
    email: "owner@example.test",
    subject: "verified-owner",
    role: "owner",
    permissions: ["admins.manage"],
    requestID: "synthetic-request",
    bootstrapped: false,
  }
  const accessEmails = new Set([owner.email])
  const request = new Request("https://admin.example.test/admins", {
    method: "POST",
    headers: {
      origin: "https://admin.example.test",
      "cf-ray": "synthetic-request",
      "content-type": "application/x-www-form-urlencoded",
    },
  })
  await run(
    "insert into platform_admin(id,email,access_subject,role,status) values (?,?,?,'owner','active')",
    owner.id,
    owner.email,
    owner.subject,
  )
  const restoreOwner = () =>
    run(
      "update platform_admin set email=?,access_subject=?,role='owner',status='active',time_deleted=null where id=?",
      owner.email,
      owner.subject,
      owner.id,
    )
  let sequence = 0
  const seed = async (name: string, role = "support", status = "active") => {
    const id = `adm_${String(++sequence).padStart(26, "0")}`
    const email = `${name}@example.test`
    await run("insert into platform_admin(id,email,role,status) values (?,?,?,?)", id, email, role, status)
    accessEmails.add(email)
    return { id, email }
  }
  const state = (id: string) => row("select * from platform_admin where id=?", id)
  const audits = (id: string) =>
    row("select count(*) count from admin_audit_log where target_id=? and outcome='success'", id)
  const mutate = (input: unknown, selectedBatch = batch, context = owner, req = request) =>
    native.mutateAdminOperator(context, req, input, { batch: selectedBatch, accessEmails })
  const create = (email: string) => ({ operation: "create", email, role: "support" })
  const onWrite = (action: () => Promise<unknown>): typeof Database.batch => {
    let calls = 0
    return async (callback) => {
      if (++calls === 2) await action()
      return batch(callback)
    }
  }
  const synchronizeSnapshots = (count: number) => {
    let arrived = 0
    let release: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return (): typeof Database.batch => {
      let calls = 0
      return async (callback) => {
        const result = await batch(callback)
        if (++calls === 1) {
          if (++arrived === count) release()
          await gate
        }
        return result
      }
    }
  }

  accessEmails.add("created@example.test")
  equal((await mutate(create(" CREATED@example.test "))).ok, true)
  const created = await row("select * from platform_admin where email='created@example.test'")
  assert.ok(created)
  equal(created.role, "support")
  equal(created.status, "active")
  equal(created.access_subject, null)
  equal(await audits(String(created.id)), { count: 1 })
  equal((await mutate(create("created@example.test"))).ok, false)
  equal(await audits(String(created.id)), { count: 1 })
  equal((await mutate(create("not-allowed@example.test"))).ok, false)
  equal(await row("select count(*) count from platform_admin where email='not-allowed@example.test'"), { count: 0 })
  equal((await mutate({ ...create("owner-grant@example.test"), role: "owner" })).ok, false)
  equal((await mutate(create("forged@example.test"), batch, { ...owner, role: "administrator" })).ok, false)
  equal(
    (
      await mutate(
        create("cross-origin@example.test"),
        batch,
        owner,
        new Request(request.url, {
          method: "POST",
          headers: { origin: "https://attacker.example.test" },
        }),
      )
    ).ok,
    false,
  )
  equal((await mutate(create("wrong-subject@example.test"), batch, { ...owner, subject: "wrong" })).ok, false)
  equal((await mutate(create("wrong-email@example.test"), batch, { ...owner, email: "wrong@example.test" })).ok, false)
  const anotherOwner = await seed("another-owner", "owner")
  for (const operation of ["update_role", "suspend", "reactivate"]) {
    equal((await mutate({ operation, operatorID: owner.id, role: "finance" })).ok, false)
    equal((await mutate({ operation, operatorID: anotherOwner.id, role: "finance" })).ok, false)
  }
  equal((await state(owner.id))?.role, "owner")
  equal((await state(anotherOwner.id))?.status, "active")

  const target = await seed("transitions")
  equal((await mutate({ operation: "update_role", operatorID: target.id, role: "finance" })).ok, true)
  equal((await state(target.id))?.role, "finance")
  equal((await mutate({ operation: "suspend", operatorID: target.id })).ok, true)
  equal((await state(target.id))?.status, "suspended")
  accessEmails.delete(target.email)
  equal((await mutate({ operation: "reactivate", operatorID: target.id })).ok, false)
  equal((await state(target.id))?.status, "suspended")
  accessEmails.add(target.email)
  equal((await mutate({ operation: "reactivate", operatorID: target.id })).ok, true)
  equal((await state(target.id))?.status, "active")
  equal(await audits(target.id), { count: 3 })
  const audit = await row(
    "select metadata from admin_audit_log where target_id=? and action='admin.operator.role_update' and outcome='success'",
    target.id,
  )
  equal(JSON.parse(String(audit?.metadata)), { email: target.email, before_role: "support", after_role: "finance" })

  accessEmails.add("create-race@example.test")
  const createGate = synchronizeSnapshots(6)
  const races = await Promise.all(
    Array.from({ length: 6 }, () => mutate(create("create-race@example.test"), createGate())),
  )
  equal(races.filter((result) => result.ok).length, 1)
  equal(await row("select count(*) count from platform_admin where email='create-race@example.test'"), { count: 1 })
  const raced = await row("select id from platform_admin where email='create-race@example.test'")
  equal(await audits(String(raced?.id)), { count: 1 })
  const sameRole = await seed("no-op-race")
  const updateGate = synchronizeSnapshots(6)
  const updates = await Promise.all(
    Array.from({ length: 6 }, () =>
      mutate({ operation: "update_role", operatorID: sameRole.id, role: "support" }, updateGate()),
    ),
  )
  equal(updates.filter((result) => result.ok).length, 1)
  equal(await audits(sameRole.id), { count: 1 })
  equal((await state(sameRole.id))?.role, "support")

  for (const change of ["suspended", "deleted", "role", "email", "subject"]) {
    for (const operation of ["create", "suspend"]) {
      const operator = await seed(`actor-${change}-${operation}`)
      const email = `new-${change}@example.test`
      accessEmails.add(email)
      const original = await state(operator.id)
      const selectedBatch = onWrite(async () => {
        if (change === "suspended") return run("update platform_admin set status='suspended' where id=?", owner.id)
        if (change === "deleted")
          return run("update platform_admin set time_deleted=? where id=?", Date.now(), owner.id)
        if (change === "role") return run("update platform_admin set role='administrator' where id=?", owner.id)
        if (change === "email")
          return run("update platform_admin set email='changed-owner@example.test' where id=?", owner.id)
        return run("update platform_admin set access_subject='changed-owner-subject' where id=?", owner.id)
      })
      equal(
        (await mutate(operation === "create" ? create(email) : { operation, operatorID: operator.id }, selectedBatch))
          .ok,
        false,
      )
      equal(await state(operator.id), original)
      equal(await audits(operator.id), { count: 0 })
      equal(await row("select count(*) count from platform_admin where email=?", email), { count: 0 })
      await restoreOwner()
    }
  }

  for (const change of ["role", "status", "owner", "deleted", "email", "subject", "time"]) {
    const operator = await seed(`target-${change}`)
    const selectedBatch = onWrite(async () => {
      if (change === "role") return run("update platform_admin set role='operations' where id=?", operator.id)
      if (change === "owner") return run("update platform_admin set role='owner' where id=?", operator.id)
      if (change === "status") return run("update platform_admin set status='suspended' where id=?", operator.id)
      if (change === "deleted")
        return run("update platform_admin set time_deleted=? where id=?", Date.now(), operator.id)
      if (change === "email")
        return run("update platform_admin set email='changed-target@example.test' where id=?", operator.id)
      if (change === "subject")
        return run("update platform_admin set access_subject='changed-target' where id=?", operator.id)
      return run("update platform_admin set time_updated=time_updated+1 where id=?", operator.id)
    })
    equal(
      (await mutate({ operation: "update_role", operatorID: operator.id, role: "finance" }, selectedBatch)).ok,
      false,
    )
    equal((await state(operator.id))?.role === "finance", false)
    equal(await audits(operator.id), { count: 0 })
  }

  const rollback = await seed("rollback")
  const beforeRollback = await state(rollback.id)
  await run(
    "create trigger synthetic_operator_audit_failure before insert on admin_audit_log when NEW.outcome='success' and NEW.action like 'admin.operator.%' begin select raise(ABORT,'synthetic audit failure'); end",
  )
  accessEmails.add("rollback-create@example.test")
  equal((await mutate(create("rollback-create@example.test"))).ok, false)
  equal(await row("select count(*) count from platform_admin where email='rollback-create@example.test'"), { count: 0 })
  equal((await mutate({ operation: "suspend", operatorID: rollback.id })).ok, false)
  equal(await state(rollback.id), beforeRollback)
  equal(await audits(rollback.id), { count: 0 })
  await run("drop trigger synthetic_operator_audit_failure")
  await run(
    "create trigger synthetic_operator_ignore before update on platform_admin when NEW.email='rollback@example.test' begin select raise(IGNORE); end",
  )
  equal((await mutate({ operation: "suspend", operatorID: rollback.id })).ok, false)
  equal(await state(rollback.id), beforeRollback)
  equal(await audits(rollback.id), { count: 0 })
  await run("drop trigger synthetic_operator_ignore")
  await run(
    "create trigger synthetic_operator_insert_ignore before insert on platform_admin when NEW.email='ignored@example.test' begin select raise(IGNORE); end",
  )
  accessEmails.add("ignored@example.test")
  equal((await mutate(create("ignored@example.test"))).ok, false)
  equal(await row("select count(*) count from platform_admin where email='ignored@example.test'"), { count: 0 })
  await run("drop trigger synthetic_operator_insert_ignore")

  const unknown = await seed("lost-ack")
  let calls = 0
  const lostAck: typeof Database.batch = async (callback) => {
    if (++calls > 2) throw new Error("Synthetic audit unavailable")
    const result = await batch(callback)
    if (calls === 2) throw new Error("Synthetic lost write acknowledgement")
    return result
  }
  const uncertain = await mutate({ operation: "suspend", operatorID: unknown.id }, lostAck)
  equal(uncertain.ok, false)
  equal(uncertain.message.includes("баталгаажуулж чадсангүй"), true)
  equal(uncertain.message.includes("өөрчлөлт хийгдээгүй"), false)
  equal(calls, 3)
  equal((await state(unknown.id))?.status, "suspended")
  equal(await audits(unknown.id), { count: 1 })
  console.log(`ADMIN_OPERATORS_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Operator test escaped temp root")
  await rm(persistTo, { recursive: true, force: true })
}
function equal(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected)
  checks++
}
