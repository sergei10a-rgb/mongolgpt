import assert from "node:assert/strict"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"
import type { RuntimeAccountCleanup } from "../src/account-deletion-worker"

export async function runCleanupChecks(
  binding: D1Database,
  native: typeof import("./fixtures/account-deletion-native"),
) {
  const db = native.createDatabase(binding)
  let batchFailure: unknown
  const batch: typeof Database.batch = (callback) =>
    db.batch(callback(db)).catch((error) => {
      batchFailure = error
      throw error
    })
  const use: typeof Database.use = (callback) => callback(db)
  let now = 1_900_000_000_000
  let checks = 0
  const run = (query: string, ...values: (string | number | null)[]) =>
    binding
      .prepare(query)
      .bind(...values)
      .run()
  const row = <T = Record<string, unknown>>(query: string, ...values: (string | number | null)[]) =>
    binding
      .prepare(query)
      .bind(...values)
      .first<T>()
  const receipt: RuntimeAccountCleanup = async ({ requestID, accountID }) => ({ requestID, accountID, complete: true })
  const process = async (runtime: RuntimeAccountCleanup = receipt) => {
    let assertion: unknown
    batchFailure = undefined
    const result = await native.processEligibleAccountDeletions(
      { now },
      {
        use,
        batch,
        runtime: async (input) => {
          try {
            return await runtime(input)
          } catch (error) {
            if (error instanceof assert.AssertionError) assertion = error
            throw error
          }
        },
        clock: () => now,
      },
    )
    if (assertion) throw assertion
    return result
  }
  const get = (accountID: string) => native.getAccountDeletion({ accountID }, { use })
  async function seed(name: string) {
    const accountID = `acc_cleanup_${name}`
    const workspaceID = `wrk_cleanup_${name}`
    await run("insert into account (id) values (?)", accountID)
    await run("insert into workspace (id, name) values (?, 'Fixture')", workspaceID)
    await run(
      "insert into user (id, workspace_id, account_id, name, role) values (?, ?, ?, 'Private fixture name', 'admin')",
      `usr_${name}`,
      workspaceID,
      accountID,
    )
    await run(
      "insert into auth (id, provider, subject, account_id) values (?, 'email', ?, ?)",
      `auth_${name}`,
      `${name}@example.invalid`,
      accountID,
    )
    await run(
      "insert into key (id, workspace_id, user_id, name, key) values (?, ?, ?, 'Fixture key', ?)",
      `key_${name}`,
      workspaceID,
      `usr_${name}`,
      `fixture_key_${name}`,
    )
    await run(
      "insert into provider (id, workspace_id, provider, credentials) values (?, ?, 'openrouter', 'private fixture credentials')",
      `prv_${name}`,
      workspaceID,
    )
    const request = await native.requestAccountDeletion({ accountID, graceMs: 0 }, { batch, now: () => now })
    return { accountID, workspaceID, requestID: request.id }
  }

  console.log("DELETION_D1_PHASE cleanup")
  const normal = await seed("normal")
  await run("insert into account (id) values ('acc_cleanup_survivor')")
  await run(
    "insert into user (id, workspace_id, name, role) values ('usr_cleanup_invitation', ?, 'Invitation', 'member')",
    normal.workspaceID,
  )
  await rejects(native.processEligibleAccountDeletions({ now }, { use, batch }), /тохируулаагүй/)
  equal((await get(normal.accountID))?.status, "requested")
  equal(await row("select time_deleted from account where id = ?", normal.accountID), { time_deleted: null })
  await run(
    "insert into user (id, workspace_id, account_id, name, role, time_deleted) values ('usr_old_cleanup', 'wrk_old_cleanup', ?, '', 'member', ?)",
    normal.accountID,
    now - 1,
  )
  const successful = await process(async (input) => {
    equal(input.accountID, normal.accountID)
    equal([...input.workspaceIDs].sort(), [normal.workspaceID, "wrk_old_cleanup"].sort())
    equal(await row("select time_deleted, auth_version from account where id = ?", normal.accountID), {
      time_deleted: now,
      auth_version: 1,
    })
    equal(await row("select time_deleted from key where id = 'key_normal'"), { time_deleted: now })
    equal((await get(normal.accountID))?.status, "processing")
    await rejects(native.cancelAccountDeletion({ accountID: normal.accountID }, { batch }), { code: "too_late" })
    for (const query of [
      "update account set time_deleted = null where id = ?",
      "update account_deletion set status = 'failed', last_error_code = 'old_worker_failure' where account_id = ?",
      "update account_deletion_cleanup set workspace_ids = '[]' where account_id = ?",
      "delete from account_deletion_cleanup where account_id = ?",
      "insert into user (id, workspace_id, account_id, name, role) values ('usr_forbidden', 'wrk_forbidden', ?, '', 'member')",
      "insert into auth (id, provider, subject, account_id) values ('auth_forbidden', 'github', 'forbidden', ?)",
      "update user set account_id = 'other_account' where account_id = ?",
      "delete from user where account_id = ?",
    ])
      await rejects(run(query, normal.accountID), /account_(retired|cleanup)/)
    await rejects(run("update key set time_deleted = null where id = 'key_normal'"), /account_retired/)
    await rejects(
      run(
        "insert into user (id, workspace_id, account_id, name, role) values ('usr_late_member', ?, 'acc_cleanup_survivor', '', 'member')",
        normal.workspaceID,
      ),
      /account_retired/,
    )
    await rejects(
      run("update user set account_id = 'acc_cleanup_survivor' where id = 'usr_cleanup_invitation'"),
      /account_retired/,
    )
    await rejects(
      run("update auth set account_id = 'acc_cleanup_survivor' where id = 'auth_normal'"),
      /account_retired/,
    )
    await rejects(
      run(
        "insert into key (id, workspace_id, name, key) values ('key_late', ?, '', 'fixture_late_key')",
        normal.workspaceID,
      ),
      /account_retired/,
    )
    return receipt(input)
  })
  if (successful.failed && batchFailure) throw batchFailure
  equal(successful, { processed: 1, failed: 0, skipped: 0, truncated: false })
  equal((await get(normal.accountID))?.status, "completed")
  equal(await row("select name, account_id from user where id = 'usr_normal'"), { name: "", account_id: null })
  equal(await row("select credentials from provider where id = 'prv_normal'"), { credentials: "" })
  equal(await row("select count(*) as count from auth where account_id = ?", normal.accountID), { count: 0 })

  const invalid = await seed("invalid")
  equal(await process(async (input) => ({ ...(await receipt(input)), accountID: "acc_wrong" })), {
    processed: 0,
    failed: 1,
    skipped: 0,
    truncated: false,
  })
  equal((await get(invalid.accountID))?.status, "processing")
  equal(
    await row(
      "select time_runtime_completed, last_error_code from account_deletion_cleanup where request_id = ?",
      invalid.requestID,
    ),
    { time_runtime_completed: null, last_error_code: "runtime_cleanup_failed" },
  )
  await rejects(native.requestAccountDeletion({ accountID: invalid.accountID }, { batch }), { code: "not_found" })
  for (let attempt = 0; attempt < 6; attempt++) {
    now += 15 * 60_000
    equal(
      (
        await process(async () => {
          throw new Error("private external failure")
        })
      ).failed,
      1,
    )
  }
  equal((await get(invalid.accountID))?.status, "processing")
  equal(await row("select attempts from account_deletion_cleanup where request_id = ?", invalid.requestID), {
    attempts: 7,
  })
  now += 15 * 60_000
  equal((await process()).processed, 1)

  const partial = await seed("partial")
  let runtimeCalls = 0
  const counted: RuntimeAccountCleanup = async (input) => {
    runtimeCalls++
    return receipt(input)
  }
  await run(
    "create trigger fixture_cleanup_failure before update on provider when OLD.id = 'prv_partial' begin select raise(abort, 'private fixture failure'); end",
  )
  equal((await process(counted)).failed, 1)
  equal(await row("select name, account_id from user where id = 'usr_partial'"), {
    name: "Private fixture name",
    account_id: partial.accountID,
  })
  equal(
    await row(
      "select time_runtime_completed, time_completed, last_error_code from account_deletion_cleanup where request_id = ?",
      partial.requestID,
    ),
    { time_runtime_completed: now, time_completed: null, last_error_code: "account_cleanup_failed" },
  )
  await run("drop trigger fixture_cleanup_failure")
  now += 15 * 60_000
  equal((await process(counted)).processed, 1)
  equal(runtimeCalls, 1)

  const concurrent = await seed("concurrent")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const first = process(async (input) => {
    entered.resolve()
    await release.promise
    return receipt(input)
  })
  await Promise.race([
    entered.promise,
    first.then(() => {
      throw new Error("Cleanup finished before entering runtime")
    }),
  ])
  equal(await process(), { processed: 0, failed: 0, skipped: 0, truncated: false })
  equal((await get(concurrent.accountID))?.status, "processing")
  release.resolve()
  equal((await first).processed, 1)

  const stale = await seed("stale")
  const oldEntered = Promise.withResolvers<void>()
  const oldRelease = Promise.withResolvers<void>()
  const old = process(async (input) => {
    oldEntered.resolve()
    await oldRelease.promise
    return receipt(input)
  })
  await Promise.race([
    oldEntered.promise,
    old.then(() => {
      throw new Error("Cleanup finished before entering runtime")
    }),
  ])
  now += 16 * 60_000
  equal((await process()).processed, 1)
  const stable = await get(stale.accountID)
  oldRelease.resolve()
  equal((await old).skipped, 1)
  equal(await get(stale.accountID), stable)

  now += 30 * 24 * 60 * 60_000
  // Unverified legacy rows must neither be erased nor starve eligible cleanup jobs.
  await run(
    "with recursive n(i) as (select 1 union all select i+1 from n where i<50) insert into account_deletion (id, account_id, status, time_eligible, time_started, time_completed) select 'del_legacy_'||i, 'acc_legacy_'||i, 'completed', ?, ?, ? from n",
    1,
    1,
    1,
  )
  const purge = await native.purgeCompletedAccountDeletions({ now }, { use, batch })
  equal(purge.purged, 5)
  equal(purge.skipped, 0)
  equal(
    await row("select count(*) as count from account_deletion where id like 'del_legacy_%' and time_deleted is null"),
    { count: 50 },
  )
  equal(await row("select count(*) as count from account_deletion_cleanup"), { count: 0 })
  equal(await row("select id from account where id like 'acc_cleanup_%'"), { id: "acc_cleanup_survivor" })
  equal(await get(normal.accountID), undefined)

  // Two admins may both request deletion, but the first retirement must make the
  // other admin indispensable while an active member remains in the workspace.
  const sharedA = await seed("shared_a")
  const sharedB = await seed("shared_b")
  await run("insert into workspace (id, name) values ('wrk_cleanup_shared', 'Shared fixture')")
  for (const [id, account, role] of [
    ["usr_cleanup_shared_a", sharedA.accountID, "admin"],
    ["usr_cleanup_shared_b", sharedB.accountID, "admin"],
    ["usr_cleanup_shared_c", "acc_cleanup_survivor", "member"],
  ])
    await run(
      "insert into user (id, workspace_id, account_id, name, role) values (?, 'wrk_cleanup_shared', ?, 'Shared user', ?)",
      id,
      account,
      role,
    )
  for (const suffix of ["a", "b"])
    await run(
      "insert into key (id, workspace_id, user_id, name, key) values (?, 'wrk_cleanup_shared', ?, 'Shared key', ?)",
      `key_shared_${suffix}`,
      `usr_cleanup_shared_${suffix}`,
      `fixture_shared_key_${suffix}`,
    )
  await run(
    "insert into provider (id, workspace_id, provider, credentials) values ('prv_cleanup_shared', 'wrk_cleanup_shared', 'openrouter', 'shared fixture credentials')",
  )
  const called: string[] = []
  equal(
    await process(async (input) => {
      called.push(input.accountID)
      throw new Error("Synthetic runtime outage")
    }),
    { processed: 0, failed: 2, skipped: 0, truncated: false },
  )
  equal(called.length, 1)
  const retired = called[0]
  const remaining = retired === sharedA.accountID ? sharedB.accountID : sharedA.accountID
  const retiredSuffix = retired === sharedA.accountID ? "a" : "b"
  const remainingSuffix = retiredSuffix === "a" ? "b" : "a"
  equal((await get(retired))?.status, "processing")
  equal((await get(remaining))?.status, "failed")
  equal(await row("select time_deleted, auth_version from account where id = ?", remaining), {
    time_deleted: null,
    auth_version: 0,
  })
  equal(await row("select time_deleted from key where id = ?", `key_shared_${remainingSuffix}`), { time_deleted: null })
  equal(await row("select time_deleted from key where id = ?", `key_shared_${retiredSuffix}`), { time_deleted: now })
  await run(
    "insert into user (id, workspace_id, name, role) values ('usr_shared_new_invitation', 'wrk_cleanup_shared', 'Valid invitation', 'member')",
  )
  await run(
    "insert into key (id, workspace_id, user_id, name, key) values ('key_shared_new', 'wrk_cleanup_shared', ?, '', 'fixture_shared_new_key')",
    `usr_cleanup_shared_${remainingSuffix}`,
  )
  // Composite IDs may repeat across workspaces; ownership must include both columns.
  await run("insert into account (id) values ('acc_collision_owner')")
  await run(
    "insert into user (id, workspace_id, account_id, name, role) values (?, 'wrk_cleanup_shared', 'acc_collision_owner', 'Same ID, another owner', 'member')",
    retired === sharedA.accountID ? "usr_shared_a" : "usr_shared_b",
  )
  const collidingUser = retired === sharedA.accountID ? "usr_shared_a" : "usr_shared_b"
  await run(
    "insert into key (id, workspace_id, user_id, name, key) values ('key_collision', 'wrk_cleanup_shared', ?, '', 'fixture_collision_key')",
    collidingUser,
  )
  await run(
    "insert into subscription (id, workspace_id, user_id) values ('sub_collision', 'wrk_cleanup_shared', ?)",
    collidingUser,
  )
  await run(
    "insert into lite (id, workspace_id, user_id) values ('lite_collision', 'wrk_cleanup_shared', ?)",
    collidingUser,
  )
  await run(
    "insert into usage (id, workspace_id, user_id, model, provider, input_tokens, output_tokens, cost, key_id, session_id) values ('usage_collision', 'wrk_cleanup_shared', ?, 'fixture', 'fixture', 1, 1, 0, 'key_collision', 'fixture_session')",
    collidingUser,
  )
  await rejects(native.requestAccountDeletion({ accountID: remaining }, { batch, now: () => now }), {
    code: "workspace_admin_required",
  })
  now += 15 * 60_000
  const sharedResult = await process()
  if (sharedResult.failed && batchFailure) throw batchFailure
  equal(sharedResult.processed, 1)
  equal(await row("select name, time_deleted from workspace where id = 'wrk_cleanup_shared'"), {
    name: "Shared fixture",
    time_deleted: null,
  })
  equal(await row("select credentials, time_deleted from provider where id = 'prv_cleanup_shared'"), {
    credentials: "shared fixture credentials",
    time_deleted: null,
  })
  equal(await row("select account_id, time_deleted from user where id = ?", `usr_cleanup_shared_${remainingSuffix}`), {
    account_id: remaining,
    time_deleted: null,
  })
  equal(await row("select time_deleted from key where id = 'key_shared_new'"), { time_deleted: null })
  equal(await row("select key, time_deleted from key where id = 'key_collision'"), {
    key: "fixture_collision_key",
    time_deleted: null,
  })
  equal(await row("select time_deleted from subscription where id = 'sub_collision'"), { time_deleted: null })
  equal(await row("select time_deleted from lite where id = 'lite_collision'"), { time_deleted: null })
  equal(await row("select user_id, key_id, session_id from usage where id = 'usage_collision'"), {
    user_id: collidingUser,
    key_id: "key_collision",
    session_id: "fixture_session",
  })
  return checks

  function equal(actual: unknown, expected: unknown) {
    assert.deepEqual(actual, expected)
    checks++
  }
  async function rejects(promise: Promise<unknown>, expected: RegExp | { code: string }) {
    await assert.rejects(promise, expected)
    checks++
  }
}
