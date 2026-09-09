import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"

const root = await mkdtemp(join(tmpdir(), "mongolgpt-baseline-integration-"))
const scope = { accountID: "acc_baseline", workspaceID: "wrk_fresh" }
const keyID = "synthetic_baseline"
const masters = JSON.stringify({ [keyID]: Buffer.alloc(32, 9).toString("base64") })
const testMasterSecret = "checkpoint-baseline-test-secret-32-bytes"
let assertions = 0
const equal = (actual: unknown, expected: unknown) => {
  assertions++
  assert.deepEqual(actual, expected)
}
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>>> | undefined
try {
  for (const name of ["data", "config", "cache", "state"])
    process.env[`XDG_${name.toUpperCase()}_HOME`] = join(root, name)
  process.env.MONGOLGPT_RUNTIME_SECRET = testMasterSecret
  const native: typeof import("./fixtures/history-native.ts") = await import(pathToFileURL(process.argv[2]).href)
  const connect = () =>
    getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>({
      configPath: fileURLToPath(new URL("./fixtures/history-d1.jsonc", import.meta.url)),
      persist: { path: join(root, "platform") },
      remoteBindings: false,
      envFiles: [],
    })
  platform = await connect()
  for (const name of [
    "0001_history.sql",
    "0002_history_checkpoint.sql",
    "0003_file_revision.sql",
    "0004_account_retirement.sql",
    "0005_backup_write_fences.sql",
  ]) {
    for (const sql of unstable_splitSqlQuery(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")))
      await platform.env.DB.prepare(sql).run()
  }
  const calls: string[] = []
  const request = (tenant: typeof scope) =>
    native.createRuntimeCheckpointClient({
      secret: testMasterSecret,
      scope: tenant,
      request: async (input) => {
        calls.push(new URL(input.url).pathname)
        return native.handleCheckpointOutbound(
          input,
          {
            HISTORY: platform!.env.DB as unknown as NonNullable<
              Parameters<typeof native.handleCheckpointOutbound>[1]["HISTORY"]
            >,
            RUNTIME_BACKUPS: platform!.env.BACKUPS as unknown as NonNullable<
              Parameters<typeof native.handleCheckpointOutbound>[1]["RUNTIME_BACKUPS"]
            >,
            MONGOLGPT_RUNTIME_BACKUP_KEYS: masters,
            MONGOLGPT_RUNTIME_SECRET: testMasterSecret,
          },
          { params: tenant },
        )
      },
    })
  const store = () =>
    native.createHistoryStore(platform!.env.DB as unknown as Parameters<typeof native.createHistoryStore>[0])
  const workspace = join(root, "workspace")
  await mkdir(join(workspace, ".mongolgpt/data"), { recursive: true })
  const unauthorized = await native.handleCheckpointOutbound(
    new Request("http://checkpoint.mongolgpt.internal/v1/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    {
      HISTORY: platform.env.DB as unknown as NonNullable<
        Parameters<typeof native.handleCheckpointOutbound>[1]["HISTORY"]
      >,
      RUNTIME_BACKUPS: platform.env.BACKUPS as unknown as NonNullable<
        Parameters<typeof native.handleCheckpointOutbound>[1]["RUNTIME_BACKUPS"]
      >,
      MONGOLGPT_RUNTIME_SECRET: testMasterSecret,
    },
    { params: scope },
  )
  equal(unauthorized.status, 403)
  equal(await native.CloudStartup.bootstrap({ root: workspace, request: await request(scope) }), null)
  const checkpoint = await native.CloudBaseline.publish({ root: workspace, request: await request(scope) })
  equal(await store().epoch(scope), 1)
  equal((await store().checkpoint(scope))?.data, checkpoint)
  equal(checkpoint.inventory.counts, { events: 0, tombstones: 0 })
  equal(checkpoint.inventory.projects, [])
  equal(checkpoint.inventory.sessions, [])
  equal(checkpoint.inventory.tombstonesRecorded, true)
  equal(checkpoint.sqlite.backupID !== checkpoint.files.backupID, true)
  equal(await readdir(join(workspace, ".mongolgpt")), ["data"])
  equal(calls, ["/v1/bootstrap", "/v1/begin", "/v1/upload", "/v1/upload", "/v1/publish"])
  equal(
    (await readdir(root)).some((name) => name.startsWith(".mongolgpt-baseline-")),
    false,
  )

  // Reopen the actual platform storage, not an in-memory mock or prior handles.
  await platform.dispose()
  platform = await connect()
  equal(await native.CloudStartup.bootstrap({ root: workspace, request: await request(scope) }), checkpoint)
  const database = new DatabaseSync(join(workspace, ".mongolgpt/runtime.sqlite"), { readOnly: true })
  try {
    equal(database.prepare("SELECT count(*) AS count FROM session").get()?.count, 0)
    equal(database.prepare("SELECT count(*) AS count FROM project").get()?.count, 0)
    equal(Number(database.prepare("SELECT count(*) AS count FROM migration").get()?.count) > 0, true)
    equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok")
  } finally {
    database.close()
  }
  let lease: { epoch: number; writerID: string } | undefined
  const cloud = native.createCloudHistory({
    checkpointID: checkpoint.id,
    request: async (input) => {
      const response = await native.handleHistoryOutbound(
        input,
        {
          HISTORY: platform!.env.DB as unknown as NonNullable<
            Parameters<typeof native.handleHistoryOutbound>[1]["HISTORY"]
          >,
        },
        { params: scope },
      )
      if (new URL(input.url).pathname === "/v1/claim" && response.status === 200)
        lease = (await response.clone().json()) as { epoch: number; writerID: string }
      return response
    },
  })
  await native.Effect.runPromise(cloud.initialize)
  assert.ok(lease)
  equal(lease.epoch, 2)
  equal((await native.Effect.runPromise(cloud.read(0))).entries, [])
  equal(await store().epoch(scope), 2)
  const stale = await (
    await request(scope)
  )(
    new Request("http://checkpoint.mongolgpt.internal/v1/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ epoch: 1, writerID: "stale_baseline_writer", checkpoint }),
    }),
  )
  equal(stale.status, 409)
  equal((await store().checkpoint(scope))?.data, checkpoint)
  await writeFile(join(workspace, "created.txt"), "first real workspace file")
  const nativePath = join(workspace, ".mongolgpt/runtime.sqlite")
  const snapshot = new DatabaseSync(nativePath)
  snapshot.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE native_snapshot_probe (value TEXT NOT NULL)",
  )
  snapshot.prepare("INSERT INTO native_snapshot_probe VALUES (?)").run("committed native state after baseline")
  const files = await native.CloudFiles.publish({
    root: workspace,
    checkpointID: checkpoint.id,
    lease,
    signal: new AbortController().signal,
    request: await request(scope),
  }).finally(() => snapshot.close())
  equal(files.data.sequence, 1)
  equal(!!files.data.sqlite, true)
  equal(files.data.sqlite?.backupID !== files.data.archive.backupID, true)
  equal((await store().checkpoint(scope))?.data, checkpoint)
  const replacement = join(root, "replacement")
  await mkdir(replacement)
  const replaced = await native.CloudStartup.bootstrap({ root: replacement, request: await request(scope) })
  equal(replaced?.filesRevisionID, files.data.id)
  equal(replaced?.resume, {})
  equal(replaced?.sqlite, checkpoint.sqlite)
  equal(replaced?.inventory, checkpoint.inventory)
  equal(await readFile(join(replacement, "created.txt"), "utf8"), "first real workspace file")
  const restoredNative = new DatabaseSync(join(replacement, ".mongolgpt/runtime.sqlite"), { readOnly: true })
  try {
    equal(
      restoredNative.prepare("SELECT value FROM native_snapshot_probe").get()?.value,
      "committed native state after baseline",
    )
    equal(restoredNative.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok")
  } finally {
    restoredNative.close()
  }

  // Resume the same native DB, not the immutable baseline image. The cloud
  // lease prevents an old container from admitting work after replacement.
  const pending = new DatabaseSync(nativePath)
  try {
    pending.exec("CREATE TABLE resume_probe (value TEXT NOT NULL)")
    pending.prepare("INSERT INTO resume_probe VALUES (?)").run("native pending state")
  } finally {
    pending.close()
  }
  await writeFile(join(workspace, "pending.txt"), "not yet checkpointed")
  const nativeBefore = await readFile(nativePath)
  const beforeResume = calls.length
  const resumed = await native.CloudStartup.resume({
    root: workspace,
    request: await request(scope),
    checkpointID: checkpoint.id,
    expectedEpoch: 2,
  })
  equal(resumed.resume, { expectedEpoch: 2 })
  equal(resumed.filesRevisionID, files.data.id)
  equal(calls.slice(beforeResume), ["/v1/bootstrap"])
  equal(await readFile(nativePath), nativeBefore)
  equal(await readFile(join(workspace, "pending.txt"), "utf8"), "not yet checkpointed")
  const historyCalls: string[] = []
  const historyRequest = async (input: Request) => {
    historyCalls.push(new URL(input.url).pathname)
    return native.handleHistoryOutbound(
      input,
      {
        HISTORY: platform!.env.DB as unknown as NonNullable<
          Parameters<typeof native.handleHistoryOutbound>[1]["HISTORY"]
        >,
      },
      { params: scope },
    )
  }
  const resumedCloud = native.createCloudHistory({
    checkpointID: resumed.id,
    filesRevisionID: resumed.filesRevisionID,
    expectedEpoch: resumed.resume?.expectedEpoch,
    request: historyRequest,
  })
  await native.Effect.runPromise(resumedCloud.initialize)
  equal(await store().epoch(scope), 3)
  equal(historyCalls, ["/v1/epoch", "/v1/claim"])
  const outdated = native.createCloudHistory({ checkpointID: resumed.id, expectedEpoch: 2, request: historyRequest })
  await assert.rejects(native.Effect.runPromise(outdated.initialize), /Cloud runtime/)
  assertions++
  equal(historyCalls, ["/v1/epoch", "/v1/claim", "/v1/epoch"])
  equal(await store().epoch(scope), 3)
  equal(await readFile(nativePath), nativeBefore)

  // Once a claim/baseline exists, initialization never takes it over or resets it.
  const duplicate = join(root, "duplicate")
  await mkdir(duplicate)
  await assert.rejects(
    native.CloudBaseline.publish({ root: duplicate, request: await request(scope) }),
    native.CloudBaseline.BaselineError,
  )
  assertions++
  equal(await store().epoch(scope), 3)
  equal(await readdir(duplicate), [])
  equal((await store().checkpoint(scope))?.data.id, checkpoint.id)

  const lostScope = { ...scope, workspaceID: "wrk_lost_ack" }
  const lost = join(root, "lost")
  await mkdir(lost)
  await assert.rejects(
    native.CloudBaseline.publish({
      root: lost,
      request: async (input) => {
        const response = await (await request(lostScope))(input)
        if (new URL(input.url).pathname === "/v1/publish" && response.status === 200)
          throw new Error("Synthetic lost acknowledgement after durable commit")
        return response
      },
    }),
    native.CloudBaseline.BaselineError,
  )
  assertions++
  equal(await store().epoch(lostScope), 1)
  equal(!!(await store().checkpoint(lostScope)), true)
  equal(await readdir(lost), [])
  equal(
    (await readdir(root)).some((name) => name.startsWith(".mongolgpt-baseline-")),
    false,
  )
  // A new explicit startup can restore the committed generation without publishing again.
  const recovered = await native.CloudStartup.bootstrap({ root: lost, request: await request(lostScope) })
  equal(recovered?.id, (await store().checkpoint(lostScope))?.data.id)
  equal(await store().epoch(lostScope), 1)
  const raceScope = { ...scope, workspaceID: "wrk_begin_race" }
  const raced = await Promise.all(
    ["first_writer", "second_writer"].map(async (writerID) =>
      (await request(raceScope))(
        new Request("http://checkpoint.mongolgpt.internal/v1/begin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ writerID }),
        }),
      ),
    ),
  )
  equal(raced.map((response) => response.status).sort(), [200, 409])
  equal(await store().epoch(raceScope), 1)
  for (const response of raced) {
    const value = (await response.json()) as { key?: string; error?: { code: string } }
    if (response.status === 409) equal(value.key, undefined)
  }
  console.log(`CHECKPOINT_BASELINE_RESULT ${JSON.stringify({ ok: true, assertions })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), root)
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Baseline integration cleanup escaped temp root")
  await rm(root, { recursive: true, force: true })
}
