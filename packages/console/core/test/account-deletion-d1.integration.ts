import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database } from "@cloudflare/workers-types"
import type { Database } from "../src/drizzle"

const native: typeof import("./fixtures/account-deletion-native") = await import(pathToFileURL(process.argv[2]).href)
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-deletion-d1-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined
let checks = 0
const now = 2_000_000_000_000

try {
  console.log("DELETION_D1_PHASE startup")
  platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL("./fixtures/account-deletion-d1.jsonc", import.meta.url)),
    persist: { path: persistTo },
    remoteBindings: false,
    envFiles: [],
  })
  console.log("DELETION_D1_PHASE database")
  const binding = platform.env.DB
  const db = native.createDatabase(binding)
  const batch: typeof Database.batch = (callback) => db.batch(callback(db))
  const use: typeof Database.use = (callback) => callback(db)
  const request = (accountID: string, time = now, graceMs = 60_000) =>
    native.requestAccountDeletion({ accountID, graceMs }, { now: () => time, batch })
  const cancel = (accountID: string, time = now + 1_000) =>
    native.cancelAccountDeletion({ accountID }, { now: () => time, batch })
  const get = (accountID: string) => native.getAccountDeletion({ accountID }, { use })
  const run = (query: string, ...values: (string | number | null)[]) =>
    binding
      .prepare(query)
      .bind(...values)
      .run()

  // Exercise the actual Drizzle D1 driver: the previous interactive strategy is unsupported.
  await assert.rejects(
    db.transaction(async () => undefined),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      /D1_ERROR:.*SQL BEGIN TRANSACTION/.test(error.cause.message),
  )
  checks++
  const directory = fileURLToPath(new URL("../migrations-d1/", import.meta.url))
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!(await readdir(join(directory, entry.name))).includes("migration.sql")) continue
    const migration = await readFile(join(directory, entry.name, "migration.sql"), "utf8")
    for (const query of unstable_splitSqlQuery(migration)) await binding.prepare(query).run()
  }
  console.log("DELETION_D1_PHASE lifecycle")
  await run("insert into account (id) values (?), (?), (?)", "acc_one", "acc_two", "acc_deleted")
  await run("update account set time_deleted = ? where id = ?", now, "acc_deleted")
  await rejects(request("acc_missing"), { code: "not_found" })
  await rejects(request("acc_deleted"), { code: "not_found" })
  await rejects(cancel("acc_missing"), { code: "not_found" })

  const first = await request("acc_one")
  equal([first.status, first.changed, first.eligibleAt], ["requested", true, now + 60_000])
  equal(await request("acc_one", now + 5_000, 120_000), { ...first, changed: false })
  const cancelled = await cancel("acc_one")
  equal([cancelled.status, cancelled.changed, cancelled.cancelledAt], ["cancelled", true, now + 1_000])
  equal(await cancel("acc_one", now + 5_000), { ...cancelled, changed: false })
  const reopened = await request("acc_one", now + 10_000, 30_000)
  equal(
    [reopened.id, reopened.status, reopened.changed, reopened.eligibleAt],
    [first.id, "requested", true, now + 40_000],
  )
  equal(reopened.cancelledAt, undefined)

  const requests = await Promise.all(Array.from({ length: 8 }, () => request("acc_two")))
  equal(requests.filter((result) => result.changed).length, 1)
  equal(new Set(requests.map((result) => result.id)).size, 1)
  const cancellations = await Promise.all(Array.from({ length: 8 }, () => cancel("acc_two")))
  equal(cancellations.filter((result) => result.changed).length, 1)
  equal(
    cancellations.every((result) => result.status === "cancelled"),
    true,
  )

  for (let attempt = 0; attempt < 8; attempt++) {
    const id = `acc_race_${attempt}`
    await run("insert into account (id) values (?)", id)
    await request(id, now, 0)
    const [claim, cancellation] = await Promise.allSettled([
      run(
        "update account_deletion set status = 'processing', time_started = ?, attempts = 1 where account_id = ? and status = 'requested' and time_deleted is null",
        now,
        id,
      ),
      cancel(id),
    ])
    equal(claim.status, "fulfilled")
    const stored = await get(id)
    if (stored?.status === "processing") {
      equal(cancellation.status, "rejected")
      if (cancellation.status === "rejected") equal(cancellation.reason.code, "too_late")
      continue
    }
    equal(stored?.status, "cancelled")
    equal(cancellation.status, "fulfilled")
    if (claim.status === "fulfilled") equal(claim.value.meta.changes, 0)
  }

  const lostAck: typeof Database.batch = async (callback) => {
    await batch(callback)
    throw new Error("lost acknowledgement")
  }
  await rejects(
    native.requestAccountDeletion({ accountID: "acc_two" }, { batch: lostAck, now: () => now }),
    /lost acknowledgement/,
  )
  const committed = await get("acc_two")
  equal(committed?.status, "requested")
  equal(await request("acc_two"), committed)

  // A failure after the write must roll the write back, not leave a half-success.
  const rollback = (async (callback: Parameters<typeof Database.batch>[0]) => {
    const queries = callback(db)
    const doomed = db
      .select({ value: native.sql<number>`json_extract('invalid', '$')` })
      .from(native.sql`account`)
      .limit(1)
    const results = await db.batch([...queries, doomed])
    return results.slice(0, -1)
  }) as typeof Database.batch
  await rejects(
    native.cancelAccountDeletion({ accountID: "acc_two" }, { batch: rollback, now: () => now }),
    /malformed JSON/,
  )
  equal(await get("acc_two"), committed)

  await rejects(
    native.cancelAccountDeletion({ accountID: "acc_two" }, { batch: lostAck, now: () => now }),
    /lost acknowledgement/,
  )
  const cancelledAfterLoss = await get("acc_two")
  equal(cancelledAfterLoss?.status, "cancelled")
  equal(await cancel("acc_two"), cancelledAfterLoss)
  await request("acc_two")
  await run(
    "update account_deletion set status = 'failed', time_started = ?, attempts = 5, last_error_code = 'account_cleanup_failed' where account_id = ?",
    now,
    "acc_two",
  )
  const retried = await request("acc_two", now + 1_000, 20_000)
  equal([retried.changed, retried.attempts, retried.status, retried.eligibleAt], [true, 0, "requested", now + 21_000])

  await run(
    "update account_deletion set status = 'processing', time_started = ?, attempts = 1 where account_id = ?",
    now,
    "acc_one",
  )
  await rejects(cancel("acc_one"), { code: "too_late" })
  equal((await request("acc_one")).changed, false)
  await run("update account_deletion set status = 'completed', time_completed = ? where account_id = ?", now, "acc_one")
  await rejects(cancel("acc_one"), { code: "too_late" })
  equal((await request("acc_one")).status, "completed")
  equal((await get("acc_two"))?.status, "requested")

  await run("insert into account (id) values (?), (?)", "acc_admin", "acc_member")
  await run("insert into workspace (id, name) values (?, ?)", "wrk_shared", "Synthetic fixture")
  await run(
    "insert into user (id, workspace_id, account_id, role, name) values (?, ?, ?, ?, ''), (?, ?, ?, ?, '')",
    "usr_admin",
    "wrk_shared",
    "acc_admin",
    "admin",
    "usr_member",
    "wrk_shared",
    "acc_member",
    "member",
  )
  await rejects(request("acc_admin"), { code: "workspace_admin_required" })
  equal(await get("acc_admin"), undefined)
  await run("update user set role = 'admin' where id = ?", "usr_member")
  const adminRequest = await request("acc_admin")
  equal(adminRequest.status, "requested")
  await cancel("acc_admin")
  await run("update user set time_deleted = ? where id = ?", now, "usr_member")
  equal((await request("acc_admin")).changed, true)
  await cancel("acc_admin")
  await run("update user set time_deleted = null, role = 'member' where id = ?", "usr_member")
  await rejects(request("acc_admin"), { code: "workspace_admin_required" })
  equal((await get("acc_admin"))?.status, "cancelled")

  console.log(`DELETION_D1_RESULT ${JSON.stringify({ ok: true, checks })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), persistTo)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Deletion fixture escaped temp root")
  await rm(persistTo, { recursive: true, force: true })
}

function equal(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected)
  checks++
}

async function rejects(promise: Promise<unknown>, expected: RegExp | { code: string }) {
  await assert.rejects(promise, expected)
  checks++
}
