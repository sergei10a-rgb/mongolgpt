import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { PlatformAdminContext } from "../../admin/src/lib/admin-context"

const native: typeof import("./fixtures/admin-plans-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-admin-plans-d1-"))
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
  const all = (query: string) =>
    binding
      .prepare(query)
      .all()
      .then((result) => result.results)
  const directory = fileURLToPath(new URL("../migrations-d1/", import.meta.url))
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!(await readdir(join(directory, entry.name))).includes("migration.sql")) continue
    for (const query of unstable_splitSqlQuery(await readFile(join(directory, entry.name, "migration.sql"), "utf8")))
      await binding.prepare(query).run()
  }
  const admin: PlatformAdminContext = {
    id: `adm_${"P".repeat(26)}`,
    email: "plan-admin@example.test",
    subject: "verified-plan-admin",
    role: "owner",
    permissions: ["plans.manage"],
    requestID: "synthetic-request",
    bootstrapped: false,
  }
  await run(
    "insert into platform_admin(id,email,access_subject,role,status) values (?,?,?,'owner','active')",
    admin.id,
    admin.email,
    admin.subject,
  )
  const restoreAdmin = () =>
    run(
      "update platform_admin set email=?,access_subject=?,role='owner',status='active',time_deleted=null where id=?",
      admin.email,
      admin.subject,
      admin.id,
    )
  const paid = (multiplier: number) => ({
    weeklyCostLimit: multiplier,
    weeklyTokenLimit: 100 * multiplier,
    weeklyRequestLimit: 10 * multiplier,
    monthlyCostLimit: 4 * multiplier,
    monthlyTokenLimit: 400 * multiplier,
    monthlyRequestLimit: 40 * multiplier,
    rollingCostLimit: multiplier,
    rollingWindow: 5 * multiplier,
  })
  const limits = {
    free: {
      promoTokens: 0,
      dailyRequests: 20,
      dailyRequestsFallback: 5,
      checkHeaders: { "x-proxy-secret": "synthetic-private-value" },
    },
    lite: { rollingLimit: 1, rollingWindow: 5, weeklyLimit: 5, monthlyLimit: 10 },
    plans: { basic: paid(1), pro: paid(2), max: paid(3) },
  }
  const stored = { ...limits, free: { promoTokens: 0, dailyRequests: 20, dailyRequestsFallback: 5 } }
  const req = new Request("https://admin.example.test/plans?token=synthetic-private-query", {
    method: "POST",
    headers: {
      origin: "https://admin.example.test",
      "content-type": "application/x-www-form-urlencoded",
    },
  })
  const state = () => row("select * from plan_config_active where id=1")
  const versions = () => all("select * from plan_config_version order by revision")
  const successes = () => all("select * from admin_audit_log where outcome='success' order by id")
  const update = async () => ({
    operation: "update",
    expectedRevision: Number((await row("select max(revision) revision from plan_config_version"))?.revision ?? 0),
    expectedActiveStateRevision: (await state())?.revision ?? null,
    note: "Туршилтын багцын лимит шинэчлэх.",
    free: stored.free,
    plans: stored.plans,
  })
  const rollback = async (sourceVersionID: string) => ({
    operation: "rollback",
    sourceVersionID,
    confirmation: "БУЦААХ",
    expectedRevision: (await update()).expectedRevision,
    expectedActiveStateRevision: (await state())?.revision ?? null,
    note: "Өмнөх багцын тохиргоонд буцаах туршилт.",
  })
  const mutate = (input: unknown, selected = batch, context = admin, request = req) =>
    native.mutateAdminPlans(context, request, input, { batch: selected, bootstrap: () => limits })
  const onWrite = (action: () => Promise<unknown>): typeof Database.batch => {
    let calls = 0
    return async (callback) => {
      if (++calls === 2) await action()
      return batch(callback)
    }
  }
  const snapshot = async () => ({ state: await state(), versions: await versions(), audits: await successes() })
  const equal = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected)
    checks++
  }
  const denied = async (input: unknown, selected = batch, context = admin, request = req) => {
    const before = await snapshot()
    equal((await mutate(input, selected, context, request)).ok, false)
    equal(await snapshot(), before)
  }

  // Synchronized cold publication: only one request may create the initial active version.
  const cold = await update()
  const contenders = 6
  let arrivals = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const synchronized = (): typeof Database.batch => {
    let calls = 0
    return async (callback) => {
      const result = await batch(callback)
      if (++calls === 1) {
        if (++arrivals === contenders) release()
        await gate
      }
      return result
    }
  }
  const coldResults = await Promise.all(Array.from({ length: contenders }, () => mutate(cold, synchronized())))
  equal(coldResults.filter((result) => result.ok).length, 1)
  equal((await versions()).length, 1)
  equal((await successes()).length, 1)
  const first = (await versions())[0]
  equal(JSON.parse(String(first.limits)), stored)
  equal((await state())?.active_version_id, first.id)
  equal((await state())?.revision, 1)
  equal(await native.PlanConfig.getRuntimeLimitsWithDb(db, limits), limits)
  equal(JSON.stringify(await snapshot()).includes("synthetic-private"), false)
  equal(JSON.stringify(await snapshot()).includes("checkHeaders"), false)

  // The real form submits flat fields. Do not add unknown rollback fields to strict update input.
  const next = await update()
  const flat = {
    operation: "update",
    expectedRevision: String(next.expectedRevision),
    expectedActiveStateRevision: String(next.expectedActiveStateRevision),
    note: next.note,
    ...Object.fromEntries(Object.entries(stored.free).map(([key, value]) => [`free.${key}`, String(value)])),
    ...Object.fromEntries(
      Object.entries(stored.plans).flatMap(([tier, values]) =>
        Object.entries(values).map(([key, value]) => [`${tier}.${key}`, String(value)]),
      ),
    ),
  }
  const second = await mutate(flat)
  assert.equal(second.ok, true, second.message)
  checks++
  equal("revision" in second && second.revision, 2)
  equal((await state())?.revision, 2)
  equal(JSON.parse(String((await versions())[1].limits)), stored)
  await denied(flat)
  await denied({ ...(await update()), expectedActiveStateRevision: null })
  await denied({ ...(await update()), expectedRevision: 0 })
  await denied({ ...(await update()), note: "english only" })
  await denied({ ...(await update()), free: { ...stored.free, checkHeaders: { leaked: "no" } } })
  await denied({
    ...(await update()),
    plans: { ...stored.plans, basic: { ...stored.plans.basic, weeklyCostLimit: 99 } },
  })
  await denied(await update(), batch, { ...admin, permissions: [] })
  await denied(await update(), batch, { ...admin, subject: "forged-subject" })
  await denied(await update(), batch, { ...admin, email: "forged@example.test" })
  await denied(
    await update(),
    batch,
    admin,
    new Request(req, {
      headers: { origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" },
    }),
  )
  await denied(await rollback(String(first.id)), batch, { ...admin, permissions: [] })
  await denied({ ...(await rollback(String(first.id))), confirmation: "NO" })
  await denied(await rollback("nonexistent-version"))
  const rolled = await mutate(await rollback(String(first.id)))
  equal(rolled.ok, true)
  equal("revision" in rolled && rolled.revision, 3)
  equal((await versions())[0], first)
  const third = (await versions())[2]
  equal(third.source_version_id, first.id)
  equal(JSON.parse(String(third.limits)), stored)
  const audit = (await successes()).at(-1)!
  equal(audit.action, "plans.rollback")
  equal(JSON.parse(String(audit.metadata)), {
    operation: "rollback",
    new_version_id: third.id,
    source_version_id: first.id,
    revision: 3,
    active_state_revision: 3,
  })
  equal(JSON.stringify(audit).includes("synthetic-private"), false)
  await assert.rejects(run("update plan_config_version set note='changed' where id=?", String(first.id)))
  checks++
  await assert.rejects(run("delete from plan_config_version where id=?", String(first.id)))
  checks++

  // Old versions may contain double-encoded JSON. They remain readable and clone into structured JSON.
  const legacyRevision = (await update()).expectedRevision + 1
  await run(
    "insert into plan_config_version(id,revision,limits,created_by) values (?,?,?,?)",
    "legacy-plan",
    legacyRevision,
    JSON.stringify(JSON.stringify({ ...stored, lite: { ...stored.lite, rollingLimit: 7 } })),
    admin.id,
  )
  equal((await mutate(await rollback("legacy-plan"))).ok, true)
  equal((await native.PlanConfig.getRuntimeLimitsWithDb(db, limits)).lite.rollingLimit, 7)
  equal((await mutate(await update())).ok, true)
  equal((await native.PlanConfig.getRuntimeLimitsWithDb(db, limits)).lite.rollingLimit, 7)
  equal((await native.PlanConfig.getRuntimeLimitsWithDb(db, limits)).free.checkHeaders, limits.free.checkHeaders)

  for (const operation of ["update", "rollback"] as const) {
    for (const patch of [
      "status='suspended'",
      "role='support'",
      "time_deleted=1",
      "access_subject='revoked-subject'",
      "email='revoked@example.test'",
    ]) {
      const input = operation === "update" ? await update() : await rollback(String(first.id))
      await denied(
        input,
        onWrite(() => run(`update platform_admin set ${patch} where id=?`, admin.id)),
      )
      await restoreAdmin()
    }
  }
  for (const patch of [
    "revision=revision+1",
    "time_updated=time_updated+1",
    "updated_by='other-admin'",
    "active_version_id='missing-version'",
  ]) {
    const input = await update()
    const before = await snapshot()
    equal(
      (
        await mutate(
          input,
          onWrite(() => run(`update plan_config_active set ${patch} where id=1`)),
        )
      ).ok,
      false,
    )
    equal(await versions(), before.versions)
    equal(await successes(), before.audits)
    await run(
      "update plan_config_active set active_version_id=?,revision=?,time_updated=?,updated_by=? where id=1",
      String(before.state?.active_version_id),
      Number(before.state?.revision),
      Number(before.state?.time_updated),
      String(before.state?.updated_by),
    )
  }
  const beforeDraft = await snapshot()
  const draftInput = await update()
  equal(
    (
      await mutate(
        draftInput,
        onWrite(() =>
          run(
            "insert into plan_config_version(id,revision,limits,created_by) values (?,?,?,?)",
            "concurrent-draft",
            draftInput.expectedRevision + 1,
            JSON.stringify(stored),
            admin.id,
          ),
        ),
      )
    ).ok,
    false,
  )
  equal(await state(), beforeDraft.state)
  equal((await versions()).length, beforeDraft.versions.length + 1)
  equal(await successes(), beforeDraft.audits)

  arrivals = 0
  const concurrentInput = await update()
  // The first gate is already released; use a fresh promise for the next shared-snapshot race.
  let arrivals2 = 0
  let release2!: () => void
  const gate2 = new Promise<void>((resolve) => {
    release2 = resolve
  })
  const updateBatch = (): typeof Database.batch => {
    let calls = 0
    return async (callback) => {
      const result = await batch(callback)
      if (++calls === 1) {
        if (++arrivals2 === contenders) release2()
        await gate2
      }
      return result
    }
  }
  const beforeConcurrent = await snapshot()
  const concurrentResults = await Promise.all(
    Array.from({ length: contenders }, () => mutate(concurrentInput, updateBatch())),
  )
  equal(concurrentResults.filter((result) => result.ok).length, 1)
  equal((await versions()).length, beforeConcurrent.versions.length + 1)
  equal((await successes()).length, beforeConcurrent.audits.length + 1)
  equal((await state())?.revision, Number(beforeConcurrent.state?.revision) + 1)

  for (const trigger of [
    "create trigger synthetic_fault before insert on admin_audit_log when NEW.outcome='success' begin select raise(abort,'audit unavailable'); end",
    "create trigger synthetic_fault before insert on plan_config_version begin select raise(ignore); end",
    "create trigger synthetic_fault before update on plan_config_active begin select raise(ignore); end",
    "create trigger synthetic_fault before update on plan_config_active begin select raise(abort,'activation unavailable'); end",
  ]) {
    await run(trigger)
    await denied(await update())
    await denied(await rollback(String(first.id)))
    await run("drop trigger synthetic_fault")
  }
  let tailCalls = 0
  const tailFailure: typeof Database.batch = async (callback) => {
    if (++tailCalls === 2) {
      await batch((value) => [
        ...callback(value),
        value.select({ invalid: native.sql`json('invalid synthetic tail')` }).from(native.sql`(select 1)`),
      ])
      throw new Error("Invalid tail unexpectedly succeeded")
    }
    return batch(callback)
  }
  await denied(await update(), tailFailure)

  // Unknown acknowledgements are not replayed or described as definitely unchanged.
  const uncertainInput = await update()
  const beforeUncertain = await snapshot()
  let ackCalls = 0
  const lostAck: typeof Database.batch = async (callback) => {
    const call = ++ackCalls
    if (call > 2) throw new Error("synthetic failure audit unavailable")
    const result = await batch(callback)
    if (call === 2) throw new Error("synthetic lost acknowledgement")
    return result
  }
  const uncertain = await mutate(uncertainInput, lostAck)
  equal(uncertain.ok, false)
  equal(uncertain.message.includes("Өөрчлөлт хийгдээгүй"), false)
  equal(uncertain.message.includes("Хуудсаа шинэчилж"), true)
  equal(ackCalls, 3)
  equal((await versions()).length, beforeUncertain.versions.length + 1)
  equal((await successes()).length, beforeUncertain.audits.length + 1)
  equal((await state())?.revision, Number(beforeUncertain.state?.revision) + 1)
  await denied(uncertainInput)

  const validState = await state()
  const invalidRevision = (await update()).expectedRevision + 1
  await run(
    "insert into plan_config_version(id,revision,limits,created_by) values (?,?,?,?)",
    "invalid-plan",
    invalidRevision,
    "{}",
    admin.id,
  )
  await denied(await rollback("invalid-plan"))
  await run("update plan_config_active set active_version_id='invalid-plan' where id=1")
  await denied(await update())
  await assert.rejects(native.PlanConfig.getRuntimeLimitsWithDb(db, limits))
  checks++
  // An explicit rollback to a validated historic version repairs corrupt active data.
  equal((await mutate(await rollback(String(first.id)))).ok, true)
  equal(await native.PlanConfig.getRuntimeLimitsWithDb(db, limits), limits)
  equal(Number((await state())?.revision), Number(validState?.revision) + 1)
  const beforeOverflow = await snapshot()
  await run("update plan_config_active set revision=2147483647 where id=1")
  await denied(await update())
  await run("update plan_config_active set revision=? where id=1", Number(beforeOverflow.state?.revision))
  equal(JSON.stringify(await snapshot()).includes("synthetic-private"), false)
  console.log(`ADMIN_PLANS_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Admin plans D1 escaped temp root")
  await rm(persistTo, { recursive: true, force: true })
}
