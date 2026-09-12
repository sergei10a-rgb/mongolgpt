import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { PlatformAdminContext } from "../../admin/src/lib/admin-context"

const native: typeof import("./fixtures/account-access-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-account-access-d1-"))
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
  const admin: PlatformAdminContext = {
    id: `adm_${"A".repeat(26)}`,
    email: "admin@example.test",
    subject: "verified-admin",
    role: "administrator",
    permissions: ["users.suspend"],
    requestID: "synthetic-request",
    bootstrapped: false,
  }
  await run(
    "insert into platform_admin(id,email,access_subject,role,status) values (?,?,?,'administrator','active')",
    admin.id,
    admin.email,
    admin.subject,
  )
  const restoreAdmin = () =>
    run(
      "update platform_admin set email=?,access_subject=?,role='administrator',status='active',time_deleted=null where id=?",
      admin.email,
      admin.subject,
      admin.id,
    )
  const request = new Request("https://admin.example.test/users?token=synthetic-private-value", {
    method: "POST",
    headers: {
      origin: "https://admin.example.test",
      "content-type": "application/x-www-form-urlencoded",
      "cf-ray": "synthetic-request",
    },
  })
  const reason = "Synthetic account status test reason."
  let sequence = 0
  const seed = async () => {
    const id = `acc_${String(++sequence).padStart(26, "0")}`
    await run("insert into account(id) values (?)", id)
    return id
  }
  const key = async (accountID: string, label: string, userID = `usr_${label}`, keyID = `key_${label}`) => {
    const workspaceID = `wrk_${label}`
    await run("insert into workspace(id,name) values (?, 'Synthetic workspace')", workspaceID)
    await run(
      "insert into user(id,workspace_id,account_id,name,role) values (?,?,?,'Synthetic member','member')",
      userID,
      workspaceID,
      accountID,
    )
    await run(
      "insert into key(id,workspace_id,user_id,name,key) values (?,?,?,'Synthetic key',?)",
      keyID,
      workspaceID,
      userID,
      `synthetic-key-${label}`,
    )
    return { workspaceID, userID, keyID }
  }
  const state = (id: string) => row("select * from account where id=?", id)
  const keyState = (value: Awaited<ReturnType<typeof key>>) =>
    row("select * from key where id=? and workspace_id=?", value.keyID, value.workspaceID)
  const audits = (id: string) =>
    row("select count(*) count from admin_audit_log where target_id=? and outcome='success'", id)
  const metadata = async (id: string, action = "account.suspend") =>
    JSON.parse(
      String(
        (
          await row(
            "select metadata from admin_audit_log where target_id=? and action=? and outcome='success' order by id desc limit 1",
            id,
            action,
          )
        )?.metadata,
      ),
    )
  const mutate = (
    accountID: string,
    operation: "suspend" | "reactivate" = "suspend",
    selectedBatch = batch,
    context = admin,
    req = request,
  ) => native.changeAdminAccountStatus(context, req, { accountID, operation, reason }, { batch: selectedBatch })
  const onWrite = (action: () => Promise<unknown>): typeof Database.batch => {
    let calls = 0
    return async (callback) => {
      if (++calls === 2) await action()
      return batch(callback)
    }
  }

  const account = await seed()
  const other = await seed()
  const first = await key(account, "first", "usr_shared", "key_shared")
  const second = await key(account, "second", "usr_second", "key_shared")
  const historical = await key(account, "historical")
  const unrelated = await key(other, "unrelated", "usr_shared", "key_shared")
  await run("update user set time_deleted=1 where workspace_id=?", historical.workspaceID)
  const unrelatedBefore = await keyState(unrelated)
  const suspended = await mutate(account)
  equal(suspended.ok, true)
  equal("changed" in suspended && suspended.changed, true)
  equal((await state(account))?.status, "suspended")
  equal((await state(account))?.auth_version, 1)
  for (const value of [first, second, historical]) equal(typeof (await keyState(value))?.time_deleted, "number")
  equal(await keyState(unrelated), unrelatedBefore)
  equal(await metadata(account), {
    operation: "suspend",
    reason,
    changed: true,
    before: "active",
    after: "suspended",
    auth_version: 1,
    revoked_api_keys: 3,
  })
  equal(await audits(account), { count: 1 })
  equal((await mutate(account)).ok, true)
  equal((await metadata(account)).changed, false)
  equal((await metadata(account)).revoked_api_keys, 0)
  const late = await key(account, "late")
  equal((await mutate(account)).ok, true)
  equal((await state(account))?.auth_version, 1)
  equal((await metadata(account)).revoked_api_keys, 1)
  equal(typeof (await keyState(late))?.time_deleted, "number")
  equal((await mutate(account, "reactivate")).ok, true)
  const reactivated = await state(account)
  equal(reactivated?.status, "active")
  equal(reactivated?.auth_version, 1)
  equal(reactivated?.suspension_reason, null)
  equal(reactivated?.time_suspended, null)
  equal((await metadata(account, "account.reactivate")).revoked_api_keys, 0)
  equal(typeof (await keyState(first))?.time_deleted, "number")
  equal(native.AccountAccess.evaluate({ id: account, status: "active", auth_version: 1, timeDeleted: null }, 0), {
    allowed: false,
    reason: "revoked",
  })
  equal((await mutate(account, "reactivate")).ok, true)
  equal((await metadata(account, "account.reactivate")).changed, false)
  const fresh = await key(account, "fresh")
  equal((await mutate(account)).ok, true)
  equal((await state(account))?.auth_version, 2)
  equal((await metadata(account)).revoked_api_keys, 1)
  equal(typeof (await keyState(fresh))?.time_deleted, "number")

  const direct = await seed()
  const directKey = await key(direct, "direct")
  const directResult = await native.AccountAccess.transition(
    { accountID: direct, adminID: admin.id, status: "suspended", reason },
    { batch, actor: admin },
  )
  equal(directResult, {
    accountID: direct,
    before: "active",
    after: "suspended",
    authVersion: 1,
    revokedApiKeys: 1,
    changed: true,
  })
  equal(typeof (await keyState(directKey))?.time_deleted, "number")
  const empty = await seed()
  equal((await mutate(empty)).ok, true)
  equal((await metadata(empty)).revoked_api_keys, 0)

  const denied = await seed()
  const deniedBefore = await state(denied)
  equal((await mutate(denied, "suspend", batch, { ...admin, permissions: [] })).ok, false)
  equal((await mutate(denied, "suspend", batch, { ...admin, subject: "forged" })).ok, false)
  equal((await mutate(denied, "suspend", batch, { ...admin, email: "forged@example.test" })).ok, false)
  equal(
    (
      await mutate(
        denied,
        "suspend",
        batch,
        admin,
        new Request(request.url, { method: "POST", headers: { origin: "https://attacker.example.test" } }),
      )
    ).ok,
    false,
  )
  equal(
    (
      await native.changeAdminAccountStatus(
        admin,
        request,
        { accountID: denied, operation: "suspend", reason: "short" },
        { batch },
      )
    ).ok,
    false,
  )
  equal(await state(denied), deniedBefore)
  equal(await audits(denied), { count: 0 })
  await run("update platform_admin set role='finance' where id=?", admin.id)
  equal((await mutate(denied)).ok, false)
  await restoreAdmin()

  const self = await seed()
  await run(
    "insert into auth(id,provider,subject,account_id) values ('aut_self','email',' ADMIN@example.test ',?)",
    self,
  )
  equal((await mutate(self)).ok, false)
  equal((await state(self))?.status, "active")
  const selfRace = await seed()
  equal(
    (
      await mutate(
        selfRace,
        "suspend",
        onWrite(() =>
          run(
            "insert into auth(id,provider,subject,account_id) values ('aut_self_race','email','admin@example.test',?)",
            selfRace,
          ),
        ),
      )
    ).ok,
    false,
  )
  equal((await state(selfRace))?.status, "active")
  equal(await audits(selfRace), { count: 0 })

  for (const change of ["status", "role", "email", "subject", "deleted"]) {
    const target = await seed()
    const targetKey = await key(target, `actor-${change}`)
    const before = await state(target)
    const keyBefore = await keyState(targetKey)
    equal(
      (
        await mutate(
          target,
          "suspend",
          onWrite(async () => {
            if (change === "status") return run("update platform_admin set status='suspended' where id=?", admin.id)
            if (change === "role") return run("update platform_admin set role='support' where id=?", admin.id)
            if (change === "email")
              return run("update platform_admin set email='changed@example.test' where id=?", admin.id)
            if (change === "subject")
              return run("update platform_admin set access_subject='changed' where id=?", admin.id)
            return run("update platform_admin set time_deleted=? where id=?", Date.now(), admin.id)
          }),
        )
      ).ok,
      false,
    )
    equal(await state(target), before)
    equal(await keyState(targetKey), keyBefore)
    equal(await audits(target), { count: 0 })
    await restoreAdmin()
  }
  for (const change of ["deleted", "version", "time", "status"]) {
    const target = await seed()
    const targetKey = await key(target, `account-${change}`)
    equal(
      (
        await mutate(
          target,
          "suspend",
          onWrite(async () => {
            if (change === "deleted") return run("update account set time_deleted=? where id=?", Date.now(), target)
            if (change === "version") return run("update account set auth_version=auth_version+1 where id=?", target)
            if (change === "time") return run("update account set time_updated=time_updated+1 where id=?", target)
            return run(
              "update account set status='suspended',suspension_reason=?,suspended_by=?,time_suspended=? where id=?",
              reason,
              admin.id,
              Date.now(),
              target,
            )
          }),
        )
      ).ok,
      false,
    )
    equal((await keyState(targetKey))?.time_deleted, null)
    equal(await audits(target), { count: 0 })
  }
  const moved = await seed()
  const movedKey = await key(moved, "moved")
  equal(
    (
      await mutate(
        moved,
        "suspend",
        onWrite(() =>
          run(
            "update user set account_id=? where id=? and workspace_id=?",
            other,
            movedKey.userID,
            movedKey.workspaceID,
          ),
        ),
      )
    ).ok,
    true,
  )
  equal((await keyState(movedKey))?.time_deleted, null)
  equal((await metadata(moved)).revoked_api_keys, 0)
  const added = await seed()
  await key(added, "added-before")
  equal(
    (
      await mutate(
        added,
        "suspend",
        onWrite(() => key(added, "added-during")),
      )
    ).ok,
    true,
  )
  equal((await metadata(added)).revoked_api_keys, 2)

  const concurrent = await seed()
  await key(concurrent, "concurrent")
  let arrived = 0
  let release: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const synchronized = (): typeof Database.batch => {
    let calls = 0
    return async (callback) => {
      const result = await batch(callback)
      if (++calls === 1) {
        if (++arrived === 6) release()
        await gate
      }
      return result
    }
  }
  const races = await Promise.all(Array.from({ length: 6 }, () => mutate(concurrent, "suspend", synchronized())))
  equal(races.filter((result) => result.ok).length, 1)
  equal((await state(concurrent))?.auth_version, 1)
  equal(await audits(concurrent), { count: 1 })
  equal((await metadata(concurrent)).revoked_api_keys, 1)

  for (const failure of ["audit", "key", "ignore_key", "ignore_account", "tail"]) {
    const target = await seed()
    const targetKey = await key(target, `rollback-${failure}`)
    const before = await state(target)
    const keyBefore = await keyState(targetKey)
    if (failure === "audit")
      await run(
        "create trigger synthetic_account_failure before insert on admin_audit_log when NEW.outcome='success' and NEW.action='account.suspend' begin select raise(ABORT,'synthetic audit failure'); end",
      )
    if (failure === "key")
      await run(
        "create trigger synthetic_account_failure before update on key begin select raise(ABORT,'synthetic key failure'); end",
      )
    if (failure === "ignore_key")
      await run("create trigger synthetic_account_failure before update on key begin select raise(IGNORE); end")
    if (failure === "ignore_account")
      await run("create trigger synthetic_account_failure before update on account begin select raise(IGNORE); end")
    let calls = 0
    const doomed = (async (callback: Parameters<typeof Database.batch>[0]) => {
      if (++calls !== 2) return batch(callback)
      const invalid = db
        .select({ value: native.sql<number>`json_extract('invalid', '$')` })
        .from(native.sql`(select 1)`)
      return (await db.batch([...callback(db), invalid])).slice(0, -1)
    }) as typeof Database.batch
    equal((await mutate(target, "suspend", failure === "tail" ? doomed : batch)).ok, false)
    equal(await state(target), before)
    equal(await keyState(targetKey), keyBefore)
    equal(await audits(target), { count: 0 })
    if (failure !== "tail") await run("drop trigger synthetic_account_failure")
  }

  const lost = await seed()
  const lostKey = await key(lost, "lost-ack")
  let lostCalls = 0
  const lostAck: typeof Database.batch = async (callback) => {
    if (++lostCalls > 2) throw new Error("Synthetic audit unavailable")
    const result = await batch(callback)
    if (lostCalls === 2) throw new Error("Synthetic lost acknowledgement")
    return result
  }
  const unknown = await mutate(lost, "suspend", lostAck)
  equal(unknown.ok, false)
  equal(unknown.message.includes("баталгаажуулж чадсангүй"), true)
  equal(unknown.message.includes("өөрчлөлт хийгдээгүй"), false)
  equal(lostCalls, 3)
  equal((await state(lost))?.auth_version, 1)
  equal(typeof (await keyState(lostKey))?.time_deleted, "number")
  equal(await audits(lost), { count: 1 })
  equal((await mutate(lost)).ok, true)
  equal((await state(lost))?.auth_version, 1)
  equal((await metadata(lost)).changed, false)
  equal((await metadata(lost)).revoked_api_keys, 0)
  const maximum = await seed()
  await run("update account set auth_version=? where id=?", Number.MAX_SAFE_INTEGER, maximum)
  equal((await mutate(maximum)).ok, false)
  equal((await state(maximum))?.status, "active")
  equal((await state(maximum))?.auth_version, Number.MAX_SAFE_INTEGER)

  await batch((tx) => [
    native.adminAuditQuery(
      tx,
      {
        actorEmail: admin.email,
        action: "synthetic.sql-metadata",
        outcome: "success",
        request,
        metadata: native.sql`json_object('safe', 1, 'flag', json('true'))`,
      },
      native.sql`1 = 1`,
    ),
  ])
  equal(
    JSON.parse(
      String((await row("select metadata from admin_audit_log where action='synthetic.sql-metadata'"))?.metadata),
    ),
    { safe: 1, flag: true },
  )
  console.log(`ACCOUNT_ACCESS_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Account access test escaped temp root")
  await rm(persistTo, { recursive: true, force: true })
}
function equal(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected)
  checks++
}
