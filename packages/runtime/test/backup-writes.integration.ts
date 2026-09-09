import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"

type Native = typeof import("./fixtures/backup-writes-native.ts")
const native = (await import(pathToFileURL(process.argv[2]).href)) as Native
const root = await mkdtemp(join(tmpdir(), "mongolgpt-backup-writes-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>>> | undefined
let assertions = 0
const payload = new Uint8Array([...new TextEncoder().encode("MONGOLGPT-SQLITE-BACKUP\0\x01"), ...Array(80).fill(7)])
const scope = { accountID: "acc_backup_write", workspaceID: "wrk_shared" }

try {
  console.log("BACKUP_WRITES_PHASE starting")
  platform = await getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>({
    configPath: fileURLToPath(new URL("./fixtures/history-d1.jsonc", import.meta.url)),
    persist: { path: root },
    remoteBindings: false,
    envFiles: [],
  })
  const db = platform.env.DB
  const bucket = platform.env.BACKUPS
  for (const file of [
    "0001_history.sql",
    "0002_history_checkpoint.sql",
    "0003_file_revision.sql",
    "0004_account_retirement.sql",
    "0005_backup_write_fences.sql",
  ]) {
    const sql = await readFile(fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)), "utf8")
    for (const statement of unstable_splitSqlQuery(sql)) await db.prepare(statement).run()
  }
  const history = native.createHistoryStore(db)
  let writes = 0
  const observed = {
    get: bucket.get.bind(bucket),
    put: (async (key, value, options) => {
      equal(await state(key), 0, "R2 write preceded its durable reservation")
      equal(options?.onlyIf, { etagDoesNotMatch: "*" }, "write lost immutable conditional")
      writes++
      return bucket.put(key, value, options)
    }) as R2Bucket["put"],
  }
  const store = native.createRuntimeBackupStore(native.createRetirableBackupBucket(db, observed, scope))
  const saved = await store.save(scope, { keyID: "test", body: stream() })
  equal(writes, 2, "single-chunk backup must reserve chunk and manifest")
  const prefix = `runtime-backups/v1/${scope.accountID}/${scope.workspaceID}/${saved.backupID}`
  const firstKey = `${prefix}/000000.bin`
  equal(await state(firstKey), 1, "acknowledged chunk not settled")
  equal(await state(`${prefix}/manifest.json`), 1, "acknowledged manifest not settled")
  equal(
    new Uint8Array(await new Response((await store.open(scope, saved.backupID)).body).arrayBuffer()),
    payload,
    "guarded archive read changed bytes",
  )
  const guarded = native.createRetirableBackupBucket(db, observed, scope)
  await rejected(guarded.put(firstKey, payload, { onlyIf: { etagDoesNotMatch: "*" } }))
  equal(writes, 2, "same-key retry issued another write")
  await rejected(guarded.put(objectKey(scope.accountID, "invalid-options"), payload))
  await rejected(guarded.put(objectKey("acc_other", "cross-scope"), payload, { onlyIf: { etagDoesNotMatch: "*" } }))
  await rejected(guarded.get(objectKey("acc_other", "cross-read")))
  equal(writes, 2, "invalid input reached R2")

  console.log("BACKUP_WRITES_PHASE isolation")
  const other = { ...scope, accountID: `${scope.accountID}2` }
  const otherStore = native.createRuntimeBackupStore(native.createRetirableBackupBucket(db, bucket, other))
  const otherSaved = await otherStore.save(other, { keyID: "test", body: stream() })
  await rejected(native.eraseRetiredBackupWritePage(db, bucket, { accountID: scope.accountID }))
  equal((await bucket.head(firstKey))?.size, payload.byteLength, "active account cleanup altered data")
  await history.retire(scope.accountID)
  equal(
    await native.eraseRetiredBackupWritePage(db, bucket, { accountID: scope.accountID }),
    { processed: 2, retainedFences: 0, next: null },
    "settled cleanup receipt mismatch",
  )
  equal(
    (await bucket.list({ prefix: `runtime-backups/v1/${scope.accountID}/` })).objects.length,
    0,
    "settled data remains",
  )
  equal(
    (await otherStore.open(other, otherSaved.backupID)).manifest.backupID,
    otherSaved.backupID,
    "neighbor account was affected",
  )
  await rejected(
    guarded.put(objectKey(scope.accountID, "after-retirement"), payload, { onlyIf: { etagDoesNotMatch: "*" } }),
  )
  equal(writes, 2, "retired admission issued a write")

  console.log("BACKUP_WRITES_PHASE late_write")
  const lateScope = { ...scope, accountID: "acc_late_write" }
  const lateKey = objectKey(lateScope.accountID, "late")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const delayed = native.createRetirableBackupBucket(
    db,
    {
      get: bucket.get.bind(bucket),
      put: (async (key, value, options) => {
        entered.resolve()
        await release.promise
        return bucket.put(key, value, options)
      }) as R2Bucket["put"],
    },
    lateScope,
  )
  const delayedResult = delayed.put(lateKey, payload, { onlyIf: { etagDoesNotMatch: "*" } })
  await entered.promise
  equal(await state(lateKey), 0, "late write not durably registered")
  await history.retire(lateScope.accountID)
  equal(
    await native.eraseRetiredBackupWritePage(db, bucket, lateScope),
    { processed: 1, retainedFences: 1, next: null },
    "uncertain write was not fenced",
  )
  await fence(lateKey)
  release.resolve()
  await rejected(delayedResult)
  await fence(lateKey)
  equal(await state(lateKey), 1, "definitively rejected late write did not settle")
  equal(
    (await native.eraseRetiredBackupWritePage(db, bucket, lateScope)).retainedFences,
    0,
    "settled fence not reclaimable",
  )
  equal(await bucket.head(lateKey), null, "settled fence not deleted")

  console.log("BACKUP_WRITES_PHASE lost_acknowledgement")
  const lostScope = { ...scope, accountID: "acc_lost_ack" }
  const lostKey = objectKey(lostScope.accountID, "lost")
  const lost = native.createRetirableBackupBucket(
    db,
    {
      get: bucket.get.bind(bucket),
      put: (async (key, value, options) => {
        await bucket.put(key, value, options)
        throw new Error("private upstream acknowledgement failure")
      }) as R2Bucket["put"],
    },
    lostScope,
  )
  await rejected(lost.put(lostKey, payload, { onlyIf: { etagDoesNotMatch: "*" } }))
  equal(await state(lostKey), 0, "uncertain put incorrectly marked settled")
  equal((await bucket.head(lostKey))?.size, payload.byteLength, "lost-ack fixture did not really write")
  await history.retire(lostScope.accountID)
  await native.eraseRetiredBackupWritePage(db, bucket, lostScope)
  await fence(lostKey)
  equal(
    await bucket.put(lostKey, payload, { onlyIf: { etagDoesNotMatch: "*" } }),
    null,
    "late replay overwrote permanent fence",
  )
  const restarted = native.createRetirableBackupBucket(db, bucket, lostScope)
  await rejected(restarted.put(lostKey, payload, { onlyIf: { etagDoesNotMatch: "*" } }))
  await rejected(db.prepare("DELETE FROM runtime_backup_write WHERE object_key = ?").bind(lostKey).run(), false)
  equal(await state(lostKey), 0, "uncertain write inventory was removed")
  await native.eraseRetiredBackupWritePage(db, bucket, lostScope)
  await fence(lostKey)

  console.log("BACKUP_WRITES_PHASE cleanup_failures")
  const cleanupBucket = {
    put: bucket.put.bind(bucket),
    delete: bucket.delete.bind(bucket),
    head: bucket.head.bind(bucket),
  }
  await rejected(
    native.eraseRetiredBackupWritePage(
      db,
      {
        ...cleanupBucket,
        put: (async () => {
          throw new Error("private R2 fence failure")
        }) as R2Bucket["put"],
      },
      lostScope,
    ),
  )
  await fence(lostKey)
  await rejected(
    native.eraseRetiredBackupWritePage(
      db,
      {
        ...cleanupBucket,
        head: async () => {
          throw new Error("private R2 verification failure")
        },
      },
      lostScope,
    ),
  )
  await fence(lostKey)
  const cleanupScope = { ...scope, accountID: "acc_cleanup_failure" }
  const cleanupKey = objectKey(cleanupScope.accountID, "cleanup")
  await native
    .createRetirableBackupBucket(db, bucket, cleanupScope)
    .put(cleanupKey, payload, { onlyIf: { etagDoesNotMatch: "*" } })
  await history.retire(cleanupScope.accountID)
  await rejected(
    native.eraseRetiredBackupWritePage(
      db,
      {
        ...cleanupBucket,
        delete: async () => {},
      },
      cleanupScope,
    ),
  )
  equal((await bucket.head(cleanupKey))?.size, payload.byteLength, "verification missed failed delete")
  await rejected(
    native.eraseRetiredBackupWritePage(
      db,
      {
        ...cleanupBucket,
        delete: async (key) => {
          await bucket.delete(key)
          throw new Error("private delete acknowledgement failure")
        },
      },
      cleanupScope,
    ),
  )
  equal(await bucket.head(cleanupKey), null, "lost delete acknowledgement did not really delete")
  const cleanupRetry = await native.eraseRetiredBackupWritePage(db, bucket, cleanupScope)
  equal(cleanupRetry, { processed: 1, retainedFences: 0, next: null }, "cleanup retry did not recover")
  equal(Object.hasOwn(cleanupRetry, "complete"), false, "page falsely claimed whole-account erasure")

  for (const phase of ["INSERT", "UPDATE"]) {
    const accountID = `acc_db_ack_${phase}`
    const key = objectKey(accountID, "db-ack")
    const fault = faultDatabase(phase, async (statement) => {
      await statement.run()
      throw new Error("private D1 acknowledgement failure")
    })
    let called = false
    const writer = native.createRetirableBackupBucket(
      fault,
      {
        get: bucket.get.bind(bucket),
        put: (async (...args) => {
          called = true
          return bucket.put(...args)
        }) as R2Bucket["put"],
      },
      { ...scope, accountID },
    )
    await rejected(writer.put(key, payload, { onlyIf: { etagDoesNotMatch: "*" } }))
    equal(called, phase === "UPDATE", "reservation uncertainty reached R2")
    equal(await state(key), phase === "UPDATE" ? 1 : 0, "durable lost-ack state mismatch")
    await history.retire(accountID)
    equal(
      (await native.eraseRetiredBackupWritePage(db, bucket, { accountID })).retainedFences,
      phase === "UPDATE" ? 0 : 1,
      "cleanup ignored durable acknowledgement",
    )
  }

  console.log("BACKUP_WRITES_PHASE mutable_options")
  const immutableScope = { ...scope, accountID: "acc_immutable_put" }
  const immutableKey = objectKey(immutableScope.accountID, "immutable")
  await bucket.put(immutableKey, "existing-object")
  const reserved = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const immutable = native.createRetirableBackupBucket(
    faultDatabase("INSERT", async (statement) => {
      const result = await statement.run()
      reserved.resolve()
      await resume.promise
      return result
    }),
    bucket,
    immutableScope,
  )
  const options: R2PutOptions = { onlyIf: { etagDoesNotMatch: "*" } }
  const immutableResult = immutable.put(immutableKey, payload, options)
  await reserved.promise
  options.onlyIf = undefined
  resume.resolve()
  await rejected(immutableResult)
  equal(await (await bucket.get(immutableKey))?.text(), "existing-object", "conditional mutation overwrote data")

  console.log("BACKUP_WRITES_PHASE pagination")
  const pagedAccount = "acc_paged_writes"
  const keys = Array.from({ length: 101 }, (_, index) => objectKey(pagedAccount, String(index)))
  await db.batch(
    keys.map((key) =>
      db
        .prepare("INSERT INTO runtime_backup_write (object_key, account_id, workspace_id, settled) VALUES (?, ?, ?, 1)")
        .bind(key, pagedAccount, scope.workspaceID),
    ),
  )
  await bucket.put(keys[0], payload)
  await bucket.put(keys.at(-1)!, payload)
  await history.retire(pagedAccount)
  const first = await native.eraseRetiredBackupWritePage(db, bucket, { accountID: pagedAccount })
  equal(first.processed, 100, "page limit ignored")
  equal(first.next, [...keys].sort()[99], "page cursor incorrect")
  const second = await native.eraseRetiredBackupWritePage(db, bucket, { accountID: pagedAccount, after: first.next! })
  equal(second, { processed: 1, retainedFences: 0, next: null }, "last page skipped or repeated")
  equal(
    (await bucket.list({ prefix: `runtime-backups/v1/${pagedAccount}/` })).objects.length,
    0,
    "paginated content remains",
  )
  await rejected(native.eraseRetiredBackupWritePage(db, bucket, { accountID: pagedAccount, after: firstKey }))
  await rejected(
    db.prepare("UPDATE runtime_backup_write SET account_id = 'acc_escape' WHERE object_key = ?").bind(keys[0]).run(),
    false,
  )
  await rejected(
    db.prepare("UPDATE runtime_backup_write SET settled = 0 WHERE object_key = ?").bind(keys[0]).run(),
    false,
  )
  await rejected(
    db
      .prepare("INSERT INTO runtime_backup_write (object_key, account_id, workspace_id) VALUES (?, ?, ?)")
      .bind(objectKey(pagedAccount, "retired-trigger"), pagedAccount, scope.workspaceID)
      .run(),
    false,
  )

  console.log("BACKUP_WRITES_PHASE production_outbound")
  const outboundScope = { ...scope, accountID: "acc_outbound_write" }
  const secret = "synthetic-outbound-write-secret-at-least-thirty-two-characters"
  const token = await native.deriveCheckpointControlToken(secret, outboundScope)
  const response = await native.handleCheckpointOutbound(
    new Request("http://checkpoint.mongolgpt.internal/v1/upload", {
      method: "POST",
      headers: {
        [native.checkpointControlHeader]: token,
        "content-type": "application/octet-stream",
        "content-length": String(payload.byteLength),
        "x-mongolgpt-backup-key-id": "test",
      },
      body: payload,
    }),
    {
      HISTORY: db,
      RUNTIME_BACKUPS: bucket,
      MONGOLGPT_RUNTIME_SECRET: secret,
      MONGOLGPT_RUNTIME_BACKUP_KEYS: JSON.stringify({ test: Buffer.alloc(32, 7).toString("base64") }),
    },
    { params: outboundScope },
  )
  equal(response.status, 200, `production upload failed: ${await response.clone().text()}`)
  equal(
    (await db.prepare("SELECT * FROM runtime_backup_write WHERE account_id = ?").bind(outboundScope.accountID).all())
      .results.length,
    2,
    "production outbound bypassed write inventory",
  )
  console.log(`BACKUP_WRITES_RESULT ${JSON.stringify({ ok: true, assertions, realD1: true, realR2: true })}`)

  async function state(key: string) {
    return db
      .prepare("SELECT settled FROM runtime_backup_write WHERE object_key = ?")
      .bind(key)
      .first<number>("settled")
  }
  async function fence(key: string) {
    const value = await bucket.get(key)
    equal(value?.size, 0, "fence contains data")
    equal(value?.customMetadata, { "mongolgpt-retired-write": "v1" }, "fence contains unexpected metadata")
    equal(await value?.text(), "", "fence body is not empty")
  }
  function faultDatabase(
    prefix: string,
    run: (statement: D1PreparedStatement) => Promise<D1Result>,
  ): Pick<D1Database, "prepare"> {
    return {
      prepare(query) {
        const statement = db.prepare(query)
        if (!query.startsWith(prefix)) return statement
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            return { run: () => run(bound) }
          },
        } as D1PreparedStatement
      },
    }
  }
} finally {
  try {
    await platform?.dispose()
  } finally {
    const inside = relative(resolve(tmpdir()), resolve(root))
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("backup-write cleanup escaped temp root")
    await rm(root, { recursive: true, force: true })
  }
}

function stream() {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload)
      controller.close()
    },
  })
}
function objectKey(accountID: string, suffix: string) {
  const id = Array.from(new TextEncoder().encode(suffix)).reduce((value, byte) => (value * 31 + byte) >>> 0, 0)
  return `runtime-backups/v1/${accountID}/${scope.workspaceID}/00000000-0000-4000-8000-${String(id).padStart(12, "0")}/000000.bin`
}
function equal(actual: unknown, expected: unknown, message: string) {
  assertions++
  assert.deepEqual(actual, expected, message)
}
async function rejected(work: Promise<unknown>, sanitized = true) {
  assertions++
  await assert.rejects(
    work,
    (error: unknown) => error instanceof Error && (!sanitized || !/private|SELECT|INSERT|UPDATE/.test(error.message)),
  )
}
