import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createTestHarness, unstable_splitSqlQuery, type TestHarness } from "wrangler"
import { deriveRuntimeBackupKey } from "../src/backup.ts"

const magic = Buffer.from("MONGOLGPT-SQLITE-BACKUP\0\x01")
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-backup-worker-"))
const workerScript = process.argv[2] ?? fileURLToPath(new URL("./fixtures/backup-worker.ts", import.meta.url))
const scope = { accountID: "acc_worker", workspaceID: "wrk_worker" }
const keyID = "key_worker"
const master = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex")
let server: TestHarness | undefined
let assertionCount = 0

try {
  console.log("BACKUP_WORKER_PHASE starting")
  server = createTestHarness({
    root: persistTo,
    workers: [
      {
        config: {
          name: "mongolgpt-backup-worker-test",
          main: workerScript,
          compatibility_date: "2026-07-18",
          compatibility_flags: ["nodejs_compat"],
          r2_buckets: [{ binding: "BACKUPS", bucket_name: "mongolgpt-backup-r2-worker-test", remote: false }],
          d1_databases: [
            {
              binding: "DB",
              database_name: "mongolgpt-checkpoint-worker-test",
              database_id: "00000000-0000-0000-0000-000000000003",
              remote: false,
            },
          ],
          dev: { ip: "127.0.0.1", port: 0, inspector_port: 0 },
        },
      },
    ],
  })
  await server.listen()
  console.log("BACKUP_WORKER_PHASE ready")
  const worker = server.getWorker()

  const expectedKey = Buffer.from(deriveRuntimeBackupKey(scope, keyID, master)).toString("hex")
  const derive = await worker.fetch("http://backup.test/derive")
  equal(derive.status, 200, "worker derive route failed")
  const derivePayload = (await derive.json()) as { key: string }
  equal(derivePayload.key, expectedKey, "worker HKDF output did not match Node")

  const body = Buffer.concat([magic, Buffer.alloc(12, 1), Buffer.alloc(8 * 1024 * 1024, 3), Buffer.alloc(16, 2)])
  const save = await worker.fetch("http://backup.test/backup", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  })
  if (save.status !== 200) throw new Error(`worker save failed: ${await save.clone().text()}`)
  equal(save.status, 200, "worker save succeeded")
  const saved = (await save.json()) as { key: string; manifest: { backupID: string; bytes: number; sha256: string } }
  equal(saved.key, expectedKey, "worker save route derived a different key")
  equal(saved.manifest.bytes, body.length, "worker save manifest used the wrong byte count")
  ok(isUuidV4(saved.manifest.backupID), "worker save did not return a v4 backup id")

  const open = await worker.fetch(`http://backup.test/backup/${saved.manifest.backupID}`)
  if (open.status !== 200) throw new Error(`worker open failed: ${await open.clone().text()}`)
  equal(open.status, 200, "worker open succeeded")
  equal(open.headers.get("cache-control"), "no-store", "worker open response allowed caching")
  const manifest = JSON.parse(open.headers.get("x-backup-manifest") ?? "{}")
  equal(manifest.sha256, saved.manifest.sha256, "worker open returned a different manifest")
  ok(Buffer.from(await open.arrayBuffer()).equals(body), "worker open body was not byte-identical")

  const missing = await worker.fetch("http://backup.test/backup/not-a-uuid")
  equal(missing.status, 400, "worker did not validate backup id through Effect schema")
  const missingPayload = (await missing.json()) as { code: string }
  equal(missingPayload.code, "invalid", "worker returned the wrong validation code")

  const statements = []
  for (const file of ["0001_history.sql", "0002_history_checkpoint.sql"]) {
    statements.push(...unstable_splitSqlQuery(await readFile(join(process.cwd(), "migrations", file), "utf8")))
  }
  equal(
    (await worker.fetch("http://backup.test/setup", { method: "POST", body: JSON.stringify(statements) })).status,
    200,
    "checkpoint D1 setup failed",
  )
  // Synthetic plaintext isolates streaming GCM compatibility in workerd. Native
  // SQLite inspection is exercised separately by checkpoint-d1.integration.ts.
  async function archive(size: number, corrupt = false) {
    const plain = Buffer.alloc(size, 73)
    const header = Buffer.concat([magic, randomBytes(12)])
    const cipher = createCipheriv(
      "aes-256-gcm",
      deriveRuntimeBackupKey(scope, keyID, master),
      header.subarray(magic.length),
    )
    cipher.setAAD(header)
    const encrypted = Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
    if (corrupt) encrypted[encrypted.length - 1] ^= 1
    const response = await worker.fetch("http://backup.test/backup", { method: "POST", body: encrypted })
    equal(response.status, 200, "encrypted fixture upload failed")
    const { manifest } = (await response.json()) as { manifest: { backupID: string; bytes: number; sha256: string } }
    return {
      backupID: manifest.backupID,
      keyID,
      bytes: manifest.bytes,
      sha256: manifest.sha256,
      plaintext: { bytes: plain.length, sha256: createHash("sha256").update(plain).digest("hex") },
    }
  }
  const sqlite = await archive(1024)
  const invalidFiles = await archive(8 * 1024 * 1024 - magic.length - 12 - 8, true)
  const checkpoint = {
    id: randomUUID(),
    sqlite,
    files: invalidFiles,
    inventory: {
      version: 1,
      database: { ...sqlite.plaintext, schemaSha256: "b".repeat(64) },
      projects: [],
      sessions: [],
      aggregates: [],
      eventIDs: [],
      tombstonesRecorded: true,
      tombstones: [],
      counts: { events: 0, tombstones: 0 },
    },
  }
  const rejected = await worker.fetch("http://backup.test/checkpoint", {
    method: "POST",
    body: JSON.stringify(checkpoint),
  })
  if (rejected.status !== 400) throw new Error(`invalid-tag checkpoint response: ${await rejected.text()}`)
  equal(rejected.status, 400, "workerd accepted invalid GCM tag with matching transport hashes")
  equal(((await rejected.json()) as { code: string }).code, "invalid", "GCM error was not sanitized")
  equal(
    await (await worker.fetch("http://backup.test/checkpoint")).json(),
    null,
    "failed authentication published D1 state",
  )
  checkpoint.files = await archive(8 * 1024 * 1024 - magic.length - 12 - 8)
  const published = await worker.fetch("http://backup.test/checkpoint", {
    method: "POST",
    body: JSON.stringify(checkpoint),
  })
  if (published.status !== 200) throw new Error(`checkpoint failed: ${await published.text()}`)
  equal(published.status, 200, "workerd failed to authenticate and publish multi-chunk checkpoint")
  const checkpointRead = await worker.fetch("http://backup.test/checkpoint")
  equal(checkpointRead.status, 200, "workerd checkpoint read failed")
  equal(
    ((await checkpointRead.json()) as { data: { id: string } }).data.id,
    checkpoint.id,
    "worker read different checkpoint",
  )

  console.log(`BACKUP_WORKER_RESULT ${JSON.stringify({ ok: true, skipped: false, assertions: assertionCount })}`)
} finally {
  await server?.close()
  const tempRoot = resolve(tmpdir())
  const cleanupTarget = resolve(persistTo)
  const relativeTarget = relative(tempRoot, cleanupTarget)
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error("worker R2 cleanup path escaped its temporary root")
  }
  await rm(cleanupTarget, { recursive: true, force: true })
}

function equal<T>(actual: T, expected: T, message: string) {
  assertionCount++
  assert.equal(actual, expected, message)
}

function ok(value: unknown, message: string) {
  assertionCount++
  assert.ok(value, message)
}

function isUuidV4(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}
