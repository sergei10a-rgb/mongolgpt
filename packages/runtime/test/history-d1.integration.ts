import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { D1Database } from "@cloudflare/workers-types"
import { createHistoryStore, type HistoryEvent, type HistoryScope } from "../src/history.ts"

const configPath = fileURLToPath(new URL("./fixtures/history-d1.jsonc", import.meta.url))
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-history-d1-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined
let assertionCount = 0

const scope = { accountID: "acc_one", workspaceID: "wrk_shared" } satisfies HistoryScope
const otherAccount = { accountID: "acc_two", workspaceID: "wrk_shared" } satisfies HistoryScope
const otherWorkspace = { accountID: "acc_one", workspaceID: "wrk_other" } satisfies HistoryScope

try {
  platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    persist: { path: persistTo },
    remoteBindings: false,
    envFiles: [],
  })
  const migration = await readFile(fileURLToPath(new URL("../migrations/0001_history.sql", import.meta.url)), "utf8")
  for (const statement of unstable_splitSqlQuery(migration)) {
    await platform.env.DB.prepare(statement).run()
  }
  const store = createHistoryStore(platform.env.DB)
  const initialWriters = await platform.env.DB.prepare("SELECT * FROM runtime_history_writer").all()
  equal(initialWriters.results.length, 0, "fresh local D1 persistence already contained history writers")

  const firstLease = await store.claim(scope, { expectedEpoch: 0, writerID: "writer_a" })
  equal(await store.epoch(scope), 1, "writer epoch was not durable")
  equal(
    (await store.claim(scope, { expectedEpoch: 0, writerID: "writer_a" })).epoch,
    1,
    "claim retry changed the epoch",
  )
  const firstEvent = event("evt_one", "ses_one", 0, { text: "persisted", order: { first: 1, second: 2 } })
  const firstReceipt = await store.append(firstLease, firstEvent)
  const retryReceipt = await store.append(
    firstLease,
    event("evt_one", "ses_one", 0, { order: { second: 2, first: 1 }, text: "persisted" }),
  )
  equal(firstReceipt.cursor, retryReceipt.cursor, "exact retry did not return the original cursor")

  await expectCode(store.append(firstLease, event("evt_gap", "ses_one", 2, { text: "gap" })), "conflict")
  await expectCode(store.append(firstLease, event("evt_conflict", "ses_one", 0, { text: "different" })), "conflict")
  await expectCode(store.append(firstLease, event("evt_one", "ses_one", 0, { text: "changed" })), "conflict")
  await expectCode(store.append(firstLease, event("evt_one", "ses_wrong", 0, { text: "persisted" })), "conflict")
  equal(
    (
      await platform.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM runtime_history_session WHERE session_id = 'ses_wrong'",
      ).first<{ count: number }>()
    )?.count,
    0,
    "conflicting ID created a phantom session",
  )

  const secondLease = await store.claim(scope, { expectedEpoch: 1, writerID: "writer_b" })
  await expectCode(store.claim(scope, { expectedEpoch: 0, writerID: "writer_a" }), "fenced")
  await expectCode(store.append(firstLease, event("evt_fenced", "ses_one", 1, { text: "old writer" })), "fenced")
  await store.append(secondLease, event("evt_two", "ses_one", 1, { text: "new writer" }))
  await store.append(
    secondLease,
    event("evt_boundary", "ses_one", 2, { value: "x".repeat(1_048_576 - JSON.stringify({ value: "" }).length) }),
  )
  await expectCode(
    store.append(secondLease, event("evt_oversize", "ses_one", 3, { value: "x".repeat(1_048_576) })),
    "invalid_input",
  )
  await expectCode(store.append(secondLease, event("evt_nan", "ses_one", 3, { value: Number.NaN })), "invalid_input")
  await expectCode(
    store.append(secondLease, event("evt_multibyte", "ses_one", 3, { value: "Ө".repeat(524_288) })),
    "invalid_input",
  )
  await platform.env.DB.prepare(
    `CREATE TRIGGER history_injected_failure BEFORE UPDATE OF seq ON runtime_history_session
    WHEN NEW.session_id = 'ses_one' AND NEW.seq = 3
    BEGIN SELECT RAISE(ABORT, 'injected private database detail'); END`,
  ).run()
  await expectCode(
    store.append(secondLease, event("evt_failed_transaction", "ses_one", 3, { value: "rollback" })),
    "unavailable",
  )
  equal(
    (
      await platform.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM runtime_history_event WHERE event_id = 'evt_failed_transaction'",
      ).first<{ count: number }>()
    )?.count,
    0,
    "failed append left a journal entry",
  )
  equal(
    (
      await platform.env.DB.prepare(
        "SELECT seq FROM runtime_history_session WHERE account_id = ? AND workspace_id = ? AND session_id = ?",
      )
        .bind(scope.accountID, scope.workspaceID, "ses_one")
        .first<{ seq: number }>()
    )?.seq,
    2,
    "failed append changed the session head",
  )
  await platform.env.DB.prepare("DROP TRIGGER history_injected_failure").run()

  const otherAccountLease = await store.claim(otherAccount, { expectedEpoch: 0, writerID: "writer_c" })
  await store.append(otherAccountLease, event("evt_other_account", "ses_one", 0, { tenant: "account-two" }))
  const otherWorkspaceLease = await store.claim(otherWorkspace, { expectedEpoch: 0, writerID: "writer_d" })
  await store.append(otherWorkspaceLease, event("evt_other_workspace", "ses_one", 0, { tenant: "workspace-two" }))

  const ownPage = await store.read(scope, { limit: 1 })
  ok(ownPage.entries.length === 1 && ownPage.hasMore, "bounded history paging was not enforced")
  const nextPage = await store.read(scope, { after: ownPage.cursor, limit: 1 })
  const nextEntry = nextPage.entries[0]
  ok(nextEntry?.deleted === false && nextEntry.event.id === "evt_two", "paging skipped or repeated a record")
  const otherAccountEntry = (await store.read(otherAccount, { limit: 1 })).entries[0]
  ok(
    otherAccountEntry?.deleted === false && otherAccountEntry.event.data.tenant === "account-two",
    "account isolation failed",
  )
  const otherWorkspaceEntry = (await store.read(otherWorkspace, { limit: 1 })).entries[0]
  ok(
    otherWorkspaceEntry?.deleted === false && otherWorkspaceEntry.event.data.tenant === "workspace-two",
    "workspace isolation failed",
  )
  await expectCode(store.read(scope, { limit: 11 }), "invalid_input")

  const concurrentScope = { accountID: "acc_concurrent", workspaceID: "wrk_concurrent" } satisfies HistoryScope
  const concurrentLease = await store.claim(concurrentScope, { expectedEpoch: 0, writerID: "writer_e" })
  const concurrent = await Promise.allSettled([
    store.append(concurrentLease, event("evt_concurrent_a", "ses_concurrent", 0, { value: "a" })),
    store.append(concurrentLease, event("evt_concurrent_b", "ses_concurrent", 0, { value: "b" })),
  ])
  equal(
    concurrent.filter((result) => result.status === "fulfilled").length,
    1,
    "concurrent append did not have one winner",
  )
  equal(
    (await store.read(concurrentScope, { limit: 1 })).entries.length,
    1,
    "concurrent append stored multiple winners",
  )

  const eraseScope = { accountID: "acc_erase", workspaceID: "wrk_erase" } satisfies HistoryScope
  const eraseLease = await store.claim(eraseScope, { expectedEpoch: 0, writerID: "writer_f" })
  const oldReceipt = await store.append(eraseLease, event("evt_erase", "ses_erase", 0, { secret: "must be purged" }))
  const tombstone = await store.erase(eraseLease, { id: "evt_tombstone", aggregateID: "ses_erase", seq: 1 })
  const eraseRetry = await store.erase(eraseLease, { id: "evt_tombstone", aggregateID: "ses_erase", seq: 1 })
  equal(tombstone.cursor, eraseRetry.cursor, "erase retry was not idempotent")
  const afterErase = await store.read(eraseScope, { limit: 1 })
  equal(afterErase.entries.length, 1, "erase did not leave one tombstone")
  equal(afterErase.entries[0]?.deleted, true, "erase did not leave a deleted tombstone")
  notEqual(afterErase.entries[0]?.cursor, oldReceipt.cursor, "offline cursor did not advance to the tombstone")
  const offlineTombstone = await store.read(eraseScope, { after: oldReceipt.cursor, limit: 1 })
  equal(offlineTombstone.entries.length, 1, "offline cursor did not return the tombstone")
  equal(offlineTombstone.entries[0]?.deleted, true, "offline cursor returned a live event")
  const rawEraseRows = await platform.env.DB.prepare(
    "SELECT data FROM runtime_history_event WHERE account_id = ? AND workspace_id = ?",
  )
    .bind(eraseScope.accountID, eraseScope.workspaceID)
    .all<{ data: string | null }>()
  ok(
    rawEraseRows.results.every((row) => !row.data?.includes("must be purged")),
    "erased payload remained in D1",
  )
  await expectCode(store.append(eraseLease, event("evt_resurrect", "ses_erase", 0, { resurrect: true })), "conflict")
  await expectCode(
    store.append(eraseLease, event("evt_resurrect_next", "ses_erase", 2, { resurrect: true })),
    "conflict",
  )
  equal((await store.read(otherAccount)).entries.length, 1, "erase affected another tenant")

  const database = platform.env.DB
  await expectRejected(
    database.batch([
      database
        .prepare("INSERT INTO runtime_history_writer (account_id, workspace_id, epoch, writer_id) VALUES (?, ?, ?, ?)")
        .bind("acc_batch", "wrk_batch", 1, "writer_batch"),
      database.prepare("INSERT INTO missing_history_table (value) VALUES (?)").bind("rollback"),
    ]),
  )
  const rolledBack = await database
    .prepare("SELECT * FROM runtime_history_writer WHERE account_id = ?")
    .bind("acc_batch")
    .all()
  equal(rolledBack.results.length, 0, "real D1 batch did not roll back")

  await platform.dispose()
  platform = undefined
  platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    persist: { path: persistTo },
    remoteBindings: false,
    envFiles: [],
  })
  const reopened = createHistoryStore(platform.env.DB)
  const persistedPage = await reopened.read(scope, { limit: 1 })
  equal(persistedPage.entries.length, 1, "history did not persist across dispose and reopen")
  equal(persistedPage.hasMore, true, "history page did not retain the second persisted event")
  equal(persistedPage.entries[0]?.deleted, false, "reopened history page was not a live event")
  const persistedEntry = persistedPage.entries[0]
  ok(
    persistedEntry?.deleted === false && persistedEntry.event.data.text === "persisted",
    "reopened history content changed",
  )
  const restoredLease = await reopened.claim(scope, {
    expectedEpoch: await reopened.epoch(scope),
    writerID: "writer_after_restart",
  })
  await expectCode(
    reopened.append(secondLease, event("evt_old_after_restart", "ses_one", 3, { value: "stale" })),
    "fenced",
  )
  await reopened.append(restoredLease, event("evt_new_after_restart", "ses_one", 3, { value: "continued" }))
  console.log(`HISTORY_D1_RESULT ${JSON.stringify({ ok: true, assertions: assertionCount })}`)
} finally {
  await platform?.dispose()
  const tempRoot = resolve(tmpdir())
  const cleanupTarget = resolve(persistTo)
  const relativeTarget = relative(tempRoot, cleanupTarget)
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error("local D1 cleanup path escaped its temporary root")
  }
  await rm(cleanupTarget, { recursive: true, force: true })
}

function event(id: string, aggregateID: string, seq: number, data: Record<string, unknown>): HistoryEvent {
  return { id, aggregateID, seq, type: "session.created:1", data }
}

function equal<T>(actual: T, expected: T, message: string) {
  assertionCount++
  assert.equal(actual, expected, message)
}

function notEqual<T>(actual: T, expected: T, message: string) {
  assertionCount++
  assert.notEqual(actual, expected, message)
}

function ok(value: unknown, message: string) {
  assertionCount++
  assert.ok(value, message)
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise
  } catch (error) {
    ok(error instanceof Error && !error.message.includes("injected private database detail"), "database detail leaked")
    equal((error as { code?: string }).code, code, `expected ${code}`)
    return
  }
  throw new Error(`expected ${code}`)
}

async function expectRejected(promise: Promise<unknown>) {
  try {
    await promise
  } catch {
    return
  }
  throw new Error("expected D1 operation to reject")
}
