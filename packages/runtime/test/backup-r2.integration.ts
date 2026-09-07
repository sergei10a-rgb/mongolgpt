import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy } from "wrangler"
import { createRuntimeBackupStore, deriveRuntimeBackupKey, RuntimeBackupError } from "../src/backup.ts"

const chunkBytes = 8 * 1024 * 1024
const magic = Buffer.from("MONGOLGPT-SQLITE-BACKUP\0\x01")
const configPath = process.argv[3] ?? fileURLToPath(new URL("./fixtures/backup-r2.jsonc", import.meta.url))
const persistTo = await mkdtemp(join(tmpdir(), "mongolgpt-backup-r2-"))
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ BACKUPS: R2Bucket }>>> | undefined
let assertionCount = 0

const scope = { accountID: "acc_r2", workspaceID: "wrk_r2" }
const otherAccount = { accountID: "acc_other", workspaceID: "wrk_r2" }
const otherWorkspace = { accountID: "acc_r2", workspaceID: "wrk_other" }
const keyID = "key_2026_09"
const master = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex")
const sensitiveValues: string[] = []

interface NativeFixture {
  credentialMarker: string
  createFixture(
    root: string,
    archiveKeyHex: string,
  ): Promise<{
    source: string
    archive: string
    rows: unknown
    report: unknown
    bytes: number
    sha256: string
  }>
  restoreRows(input: {
    archive: string
    destination: string
    keyHex: string
  }): Promise<{ report: { sha256: string }; rows: unknown }>
  assertRestoreFails(input: { archive: string; destination: string; keyHex: string }): Promise<void>
}

try {
  platform = await getPlatformProxy<{ BACKUPS: R2Bucket }>({
    configPath,
    persist: { path: persistTo },
    remoteBindings: false,
    envFiles: [],
  })

  const native = (await import(pathToFileURL(process.argv[2]).href)) as NativeFixture
  const originalMaster = Buffer.from(master)
  const derivedKey = deriveRuntimeBackupKey(scope, keyID, master)
  const derivedKeyHex = Buffer.from(derivedKey).toString("hex")
  sensitiveValues.push(native.credentialMarker, master.toString("hex"), master.toString("base64"), derivedKeyHex)
  ok(master.equals(originalMaster), "deriveRuntimeBackupKey mutated the caller's master key")
  notEqual(
    Buffer.from(deriveRuntimeBackupKey(otherAccount, keyID, master)).toString("hex"),
    derivedKeyHex,
    "account id did not contribute to derived key",
  )
  notEqual(
    Buffer.from(deriveRuntimeBackupKey(otherWorkspace, keyID, master)).toString("hex"),
    derivedKeyHex,
    "workspace id did not contribute to derived key",
  )
  notEqual(
    Buffer.from(deriveRuntimeBackupKey(scope, "key_2026_10", master)).toString("hex"),
    derivedKeyHex,
    "key version did not contribute to derived key",
  )
  notEqual(
    Buffer.from(deriveRuntimeBackupKey(scope, keyID, Buffer.from(master).fill(7))).toString("hex"),
    derivedKeyHex,
    "master key did not contribute to derived key",
  )
  await expectRuntimeError(
    Promise.resolve().then(() => deriveRuntimeBackupKey(scope, keyID, new Uint8Array(31))),
    "invalid",
  )
  await expectRuntimeError(
    Promise.resolve().then(() => deriveRuntimeBackupKey(scope, "../key", master)),
    "invalid",
  )
  await expectRuntimeError(
    Promise.resolve().then(() => deriveRuntimeBackupKey({ accountID: "../acc", workspaceID: "wrk_r2" }, keyID, master)),
    "invalid",
  )

  const fixture = await native.createFixture(persistTo, derivedKeyHex)
  const archive = await readFile(fixture.archive)
  ok(archive.length > chunkBytes, "fixture archive did not cross the R2 chunk boundary")
  ok(archive.subarray(0, magic.length).equals(magic), "fixture archive did not use the encrypted backup magic")
  equal(checksum(archive), fixture.sha256, "native fixture reported a different encrypted archive hash")
  ok(!archive.includes(Buffer.from(native.credentialMarker)), "encrypted archive leaked credential plaintext")

  const observed = observeBucket(platform.env.BACKUPS)
  const store = createRuntimeBackupStore(observed)
  const manifest = await store.save(scope, { keyID, body: streamFrom(archive, 1024 * 1024 + 17) })
  const prefix = objectPrefix(scope, manifest.backupID)
  const expectedChunkCount = Math.ceil(archive.length / chunkBytes)
  const chunkPuts = observed.puts.filter((put) => put.key.endsWith(".bin"))

  assert.deepEqual(Object.keys(manifest), [
    "version",
    "format",
    "accountID",
    "workspaceID",
    "backupID",
    "keyID",
    "bytes",
    "sha256",
    "chunks",
  ])
  assertionCount++
  equal(manifest.version, 1, "manifest used the wrong version")
  equal(manifest.format, "mongolgpt-sqlite-backup-v1", "manifest used the wrong format")
  equal(manifest.accountID, scope.accountID, "manifest account did not come from trusted scope")
  equal(manifest.workspaceID, scope.workspaceID, "manifest workspace did not come from trusted scope")
  equal(manifest.keyID, keyID, "manifest lost key custody identifier")
  equal(manifest.bytes, archive.length, "manifest byte count was not the encrypted archive length")
  equal(manifest.sha256, checksum(archive), "manifest hash was not the encrypted archive hash")
  ok(isUuidV4(manifest.backupID), "backup id was not a v4 UUID")
  equal(manifest.chunks.length, expectedChunkCount, "manifest chunk count did not match encrypted archive length")
  equal(chunkPuts.length, expectedChunkCount, "R2 chunk write count did not match manifest")
  equal(observed.puts.at(-1)?.key, `${prefix}/manifest.json`, "manifest was not the final R2 write")
  assert.deepEqual(
    observed.puts.map((put) => put.key),
    [...Array.from({ length: expectedChunkCount }, (_, index) => chunkKey(prefix, index)), `${prefix}/manifest.json`],
  )
  assertionCount++

  for (const [index, put] of chunkPuts.entries()) {
    ok(put.bytes.length <= chunkBytes, "R2 chunk exceeded the bounded chunk size")
    equal(put.bytes.length, manifest.chunks[index].bytes, "manifest chunk length did not match uploaded bytes")
    equal(checksum(put.bytes), manifest.chunks[index].sha256, "manifest chunk hash did not match uploaded bytes")
  }

  const savedManifestObject = await platform.env.BACKUPS.get(`${prefix}/manifest.json`)
  ok(savedManifestObject, "saved manifest was not readable from R2")
  const savedManifestText = await savedManifestObject!.text()
  assert.deepEqual(JSON.parse(savedManifestText), manifest)
  assertionCount++
  ok(
    sensitiveValues.every((value) => !savedManifestText.includes(value)),
    "manifest leaked key or credential material",
  )

  const opened = await store.open(scope, manifest.backupID)
  assert.deepEqual(opened.manifest, manifest)
  assertionCount++
  const downloaded = Buffer.from(await new Response(opened.body).arrayBuffer())
  ok(downloaded.equals(archive), "R2 downloaded archive was not byte-identical to the original encrypted bytes")
  equal(checksum(downloaded), manifest.sha256, "downloaded encrypted archive hash changed")
  const downloadedArchive = join(persistTo, "downloaded.backup")
  await writeFile(downloadedArchive, downloaded)
  const restored = await native.restoreRows({
    archive: downloadedArchive,
    destination: join(persistTo, "restored.sqlite"),
    keyHex: derivedKeyHex,
  })
  equal(restored.report.sha256, (fixture.report as { sha256: string }).sha256, "restored plaintext report hash changed")
  assert.deepEqual(restored.rows, fixture.rows)
  assertionCount++
  await native.assertRestoreFails({
    archive: downloadedArchive,
    destination: join(persistTo, "wrong-key.sqlite"),
    keyHex: Buffer.from(deriveRuntimeBackupKey(otherAccount, keyID, master)).toString("hex"),
  })
  assertionCount++

  await expectRuntimeError(store.open(scope, "not-a-uuid"), "invalid")
  await expectRuntimeError(store.open(otherAccount, manifest.backupID), "not_found")
  await expectRuntimeError(store.open(otherWorkspace, manifest.backupID), "not_found")
  await expectRuntimeError(store.open(scope, "11111111-1111-4111-8111-111111111111"), "not_found")

  await platform.env.BACKUPS.put(
    `${objectPrefix(otherAccount, manifest.backupID)}/manifest.json`,
    JSON.stringify(manifest),
  )
  await expectRuntimeError(store.open(otherAccount, manifest.backupID), "invalid")

  const tooLargeManifestID = "22222222-2222-4222-8222-222222222222"
  await platform.env.BACKUPS.put(
    `${objectPrefix(scope, tooLargeManifestID)}/manifest.json`,
    Buffer.alloc(1024 * 1024 + 1, 65),
  )
  await expectRuntimeError(store.open(scope, tooLargeManifestID), "invalid")

  const corruptManifest = { ...manifest, unexpected: true }
  await platform.env.BACKUPS.put(`${prefix}/manifest.json`, JSON.stringify(corruptManifest))
  await expectRuntimeError(store.open(scope, manifest.backupID), "invalid")
  await platform.env.BACKUPS.put(`${prefix}/manifest.json`, JSON.stringify(manifest))

  await platform.env.BACKUPS.put(`${prefix}/manifest.json`, JSON.stringify({ ...manifest, bytes: manifest.bytes + 1 }))
  await expectRuntimeError(store.open(scope, manifest.backupID), "invalid")
  await platform.env.BACKUPS.put(`${prefix}/manifest.json`, JSON.stringify(manifest))

  await platform.env.BACKUPS.put(`${prefix}/manifest.json`, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }))
  const wrongOverallHash = await store.open(scope, manifest.backupID)
  await expectRuntimeError(new Response(wrongOverallHash.body).arrayBuffer(), "invalid")
  await platform.env.BACKUPS.put(`${prefix}/manifest.json`, JSON.stringify(manifest))

  const missingChunkID = "33333333-3333-4333-8333-333333333333"
  await platform.env.BACKUPS.put(
    `${objectPrefix(scope, missingChunkID)}/manifest.json`,
    JSON.stringify({ ...manifest, backupID: missingChunkID }),
  )
  const missingChunk = await store.open(scope, missingChunkID)
  await expectRuntimeError(new Response(missingChunk.body).arrayBuffer(), "invalid")

  const corruptObserved = observeBucket(platform.env.BACKUPS)
  const corruptStore = createRuntimeBackupStore(corruptObserved)
  const corruptManifestHash = await corruptStore.save(scope, { keyID: "key_corrupt", body: streamFrom(archive) })
  const corruptPrefix = objectPrefix(scope, corruptManifestHash.backupID)
  const corruptChunk = Buffer.from(corruptObserved.puts.find((put) => put.key === chunkKey(corruptPrefix, 0))!.bytes)
  corruptChunk[magic.length + 1] ^= 1
  await platform.env.BACKUPS.put(chunkKey(corruptPrefix, 0), corruptChunk)
  const corruptOpened = await corruptStore.open(scope, corruptManifestHash.backupID)
  await expectRuntimeError(new Response(corruptOpened.body).arrayBuffer(), "invalid")

  const invalidStore = createRuntimeBackupStore(observeBucket(platform.env.BACKUPS))
  await expectRuntimeError(
    invalidStore.save(scope, {
      keyID: "key_plaintext",
      body: streamFrom(Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096)])),
    }),
    "invalid",
  )
  await expectRuntimeError(
    invalidStore.save(scope, { keyID: "key_short", body: streamFrom(Buffer.concat([magic, Buffer.alloc(28)])) }),
    "invalid",
  )

  const failingObserved = observeBucket(platform.env.BACKUPS)
  const failingStore = createRuntimeBackupStore(failingObserved)
  await expectRuntimeError(
    failingStore.save(
      { accountID: "acc_abort", workspaceID: "wrk_abort" },
      { keyID: "key_abort", body: failingStream(Buffer.concat([magic, Buffer.alloc(chunkBytes - magic.length)])) },
    ),
    "unavailable",
  )
  ok(!failingObserved.puts.some((put) => put.key.endsWith("/manifest.json")), "failed source committed a manifest")
  const failedChunk = failingObserved.puts.find((put) => put.key.endsWith(".bin"))
  if (failedChunk) {
    const failedManifestKey = `${failedChunk.key.slice(0, failedChunk.key.lastIndexOf("/"))}/manifest.json`
    equal(await platform.env.BACKUPS.get(failedManifestKey), null, "failed source left a committed manifest in R2")
  }

  console.log(`BACKUP_R2_RESULT ${JSON.stringify({ ok: true, assertions: assertionCount })}`)
} finally {
  await platform?.dispose()
  const tempRoot = resolve(tmpdir())
  const cleanupTarget = resolve(persistTo)
  const relativeTarget = relative(tempRoot, cleanupTarget)
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error("local R2 cleanup path escaped its temporary root")
  }
  await rm(cleanupTarget, { recursive: true, force: true })
}

function observeBucket(bucket: Pick<R2Bucket, "get" | "put">) {
  const puts: { key: string; bytes: Buffer }[] = []
  return {
    puts,
    get: (...input: Parameters<R2Bucket["get"]>) => bucket.get(...input),
    put: async (...input: Parameters<R2Bucket["put"]>) => {
      const bytes = await putBytes(input[1])
      puts.push({ key: input[0], bytes })
      return bucket.put(input[0], bytes, input[2])
    },
  }
}

async function putBytes(value: Parameters<R2Bucket["put"]>[1]) {
  if (typeof value === "string") return Buffer.from(value)
  if (value instanceof ReadableStream) return Buffer.from(await new Response(value).arrayBuffer())
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof Blob) return Buffer.from(await value.arrayBuffer())
  throw new Error("unsupported R2 put value in test observer")
}

function streamFrom(value: Uint8Array, size = 384 * 1024) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < value.byteLength; offset += size) {
        controller.enqueue(value.subarray(offset, Math.min(value.byteLength, offset + size)))
      }
      controller.close()
    },
  })
}

function failingStream(first: Uint8Array) {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(first)
        return
      }
      controller.error(new Error("source stream failed with private detail"))
    },
  })
}

function objectPrefix(input: { accountID: string; workspaceID: string }, backupID: string) {
  return `runtime-backups/v1/${input.accountID}/${input.workspaceID}/${backupID}`
}

function chunkKey(prefix: string, index: number) {
  return `${prefix}/${String(index).padStart(6, "0")}.bin`
}

function checksum(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function isUuidV4(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
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

async function expectRuntimeError(promise: Promise<unknown>, code: RuntimeBackupError["code"]) {
  try {
    await promise
  } catch (error) {
    ok(error instanceof RuntimeBackupError, "runtime backup rejected with an unsanitized error type")
    equal(error instanceof RuntimeBackupError ? error.code : undefined, code, `expected ${code}`)
    ok(!String(error).includes("private detail"), "runtime backup error leaked source failure details")
    ok(
      sensitiveValues.every((value) => !String(error).includes(value)),
      "runtime backup error leaked sensitive material",
    )
    return
  }
  throw new Error(`expected RuntimeBackupError ${code}`)
}
