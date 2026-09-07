import { createHash, hkdfSync } from "node:crypto"
import { Schema } from "effect"
import type { HistoryScope } from "./history"

const chunkBytes = 8 * 1024 * 1024
const maxBytes = 16 * 1024 * 1024 * 1024 + 128
const maxManifestBytes = 1024 * 1024
const magic = new TextEncoder().encode("MONGOLGPT-SQLITE-BACKUP\0\x01")
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/))
const BackupID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const Bytes = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maxBytes))
const Scope = Schema.Struct({ accountID: Identifier, workspaceID: Identifier })
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  format: Schema.Literal("mongolgpt-sqlite-backup-v1"),
  accountID: Identifier,
  workspaceID: Identifier,
  backupID: BackupID,
  keyID: Identifier,
  bytes: Bytes,
  sha256: Hash,
  chunks: Schema.Array(
    Schema.Struct({ bytes: Bytes.check(Schema.isLessThanOrEqualTo(chunkBytes)), sha256: Hash }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(Math.ceil(maxBytes / chunkBytes))),
})
export type RuntimeBackupManifest = typeof Manifest.Type

export class RuntimeBackupError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "unavailable") {
    super(
      {
        invalid: "Нөөцийн өгөгдөл эсвэл бүрэн бүтэн байдлын шалгалт буруу байна.",
        not_found: "Энэ workspace-ийн бүрэн нөөц олдсонгүй.",
        unavailable: "Нөөц хадгалах үйлчилгээнд түр холбогдож чадсангүй.",
      }[code],
    )
    this.name = "RuntimeBackupError"
  }
}

/** Keep environment-specific, versioned master keys in Worker secrets, never in a sandbox or R2.
 * Only the derived tenant key may reach that tenant's snapshot/restore process.
 * Retain previous master-key versions until their last backup has expired.
 */
export function deriveRuntimeBackupKey(tenant: HistoryScope, keyID: string, master: Uint8Array) {
  const scope = decode(Scope, tenant)
  const version = decode(Identifier, keyID)
  if (!(master instanceof Uint8Array) || master.byteLength !== 32) throw new RuntimeBackupError("invalid")
  const copy = Buffer.from(master)
  try {
    return new Uint8Array(
      hkdfSync(
        "sha256",
        copy,
        "mongolgpt-runtime-backup-v1",
        JSON.stringify([scope.accountID, scope.workspaceID, version]),
        32,
      ),
    )
  } catch {
    throw new RuntimeBackupError("unavailable")
  } finally {
    copy.fill(0)
  }
}

/** Worker-internal only: scope comes from trusted identity, never uploaded JSON.
 * This transports encrypted SQLite archives; the recipient must still authenticate,
 * decrypt and inspect SQLite with DatabaseBackup.restore before using the result.
 */
export function createRuntimeBackupStore(bucket: Pick<R2Bucket, "put" | "get">) {
  async function save(tenant: HistoryScope, input: { keyID: string; body: ReadableStream<Uint8Array> }) {
    const scope = decode(Scope, tenant)
    const keyID = decode(Identifier, input.keyID)
    const backupID = crypto.randomUUID()
    const prefix = objectPrefix(scope, backupID)
    const chunks: { bytes: number; sha256: string }[] = []
    const hash = createHash("sha256")
    const reader = input.body.getReader()
    const buffer = new Uint8Array(chunkBytes)
    let buffered = 0
    let bytes = 0

    async function storeChunk() {
      const value = buffer.slice(0, buffered)
      if (chunks.length === 0) checkMagic(value)
      hash.update(value)
      const sha256 = checksum(value)
      const key = chunkKey(prefix, chunks.length)
      const stored = await bucket.put(key, value, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256,
        httpMetadata: { contentType: "application/octet-stream", cacheControl: "no-store" },
      })
      if (!stored || stored.size !== value.byteLength) throw new RuntimeBackupError("unavailable")
      // Verify persisted bytes, not merely a successful upload response or ETag.
      await readChunk(bucket, key, { bytes: value.byteLength, sha256 })
      chunks.push({ bytes: value.byteLength, sha256 })
      buffered = 0
    }

    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        if (!(item.value instanceof Uint8Array)) throw new RuntimeBackupError("invalid")
        bytes += item.value.byteLength
        if (bytes > maxBytes) throw new RuntimeBackupError("invalid")
        let offset = 0
        while (offset < item.value.byteLength) {
          const length = Math.min(chunkBytes - buffered, item.value.byteLength - offset)
          buffer.set(item.value.subarray(offset, offset + length), buffered)
          buffered += length
          offset += length
          if (buffered === chunkBytes) await storeChunk()
        }
      }
      if (bytes <= magic.byteLength + 12 + 16) throw new RuntimeBackupError("invalid")
      if (buffered) await storeChunk()
      const manifest: RuntimeBackupManifest = {
        version: 1,
        format: "mongolgpt-sqlite-backup-v1",
        ...scope,
        backupID,
        keyID,
        bytes,
        sha256: hash.digest("hex"),
        chunks,
      }
      const value = new TextEncoder().encode(JSON.stringify(manifest))
      if (value.byteLength > maxManifestBytes) throw new RuntimeBackupError("invalid")
      // Only this final immutable object publishes the archive. Incomplete chunks
      // are never discoverable as a backup; no mutable "latest" pointer is trusted.
      const stored = await bucket.put(`${prefix}/manifest.json`, value, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: checksum(value),
        httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
      })
      if (!stored || stored.size !== value.byteLength) throw new RuntimeBackupError("unavailable")
      const persisted = await readManifest(scope, backupID)
      if (JSON.stringify(persisted) !== JSON.stringify(manifest)) throw new RuntimeBackupError("invalid")
      return persisted
    } catch (error) {
      throw safe(error)
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  async function readManifest(scope: HistoryScope, backupID: string) {
    const object = await bucket.get(`${objectPrefix(scope, backupID)}/manifest.json`)
    if (!object) throw new RuntimeBackupError("not_found")
    if (object.size <= 0 || object.size > maxManifestBytes) {
      await object.body.cancel()
      throw new RuntimeBackupError("invalid")
    }
    const bytes = await boundedBody(object, maxManifestBytes)
    const manifest = decode(Manifest, decode(Schema.UnknownFromJsonString, utf8(bytes)))
    if (
      manifest.accountID !== scope.accountID ||
      manifest.workspaceID !== scope.workspaceID ||
      manifest.backupID !== backupID ||
      manifest.bytes <= magic.byteLength + 12 + 16 ||
      manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== manifest.bytes ||
      manifest.chunks.slice(0, -1).some((chunk) => chunk.bytes !== chunkBytes)
    )
      throw new RuntimeBackupError("invalid")
    return manifest
  }

  async function open(tenant: HistoryScope, id: string) {
    try {
      const scope = decode(Scope, tenant)
      const backupID = decode(BackupID, id)
      const manifest = await readManifest(scope, backupID)
      const prefix = objectPrefix(scope, backupID)
      const hash = createHash("sha256")
      let index = 0
      let cancelled = false
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const value = await readChunk(bucket, chunkKey(prefix, index), manifest.chunks[index])
              if (cancelled) return
              if (index === 0) checkMagic(value)
              hash.update(value)
              index++
              if (index === manifest.chunks.length && hash.digest("hex") !== manifest.sha256) {
                throw new RuntimeBackupError("invalid")
              }
              controller.enqueue(value)
              if (index === manifest.chunks.length) controller.close()
            } catch (error) {
              if (!cancelled) controller.error(safe(error))
            }
          },
          cancel() {
            cancelled = true
          },
        },
        { highWaterMark: 0 },
      )
      return { manifest, body }
    } catch (error) {
      throw safe(error)
    }
  }

  return { save, open }
}

function objectPrefix(scope: HistoryScope, backupID: string) {
  return `runtime-backups/v1/${scope.accountID}/${scope.workspaceID}/${backupID}`
}

function chunkKey(prefix: string, index: number) {
  return `${prefix}/${String(index).padStart(6, "0")}.bin`
}

async function readChunk(bucket: Pick<R2Bucket, "get">, key: string, expected: { bytes: number; sha256: string }) {
  const object = await bucket.get(key)
  if (!object) throw new RuntimeBackupError("invalid")
  if (object.size !== expected.bytes || object.size > chunkBytes) {
    await object.body.cancel()
    throw new RuntimeBackupError("invalid")
  }
  const value = await boundedBody(object, chunkBytes)
  if (checksum(value) !== expected.sha256) throw new RuntimeBackupError("invalid")
  return value
}

async function boundedBody(object: R2ObjectBody, limit: number) {
  const reader = object.body.getReader()
  const value = new Uint8Array(object.size)
  let length = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > limit || length > value.byteLength) throw new RuntimeBackupError("invalid")
      value.set(item.value, length - item.value.byteLength)
    }
    if (length !== value.byteLength) throw new RuntimeBackupError("invalid")
    return value
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function checkMagic(value: Uint8Array) {
  if (magic.some((byte, index) => value[index] !== byte)) throw new RuntimeBackupError("invalid")
}

function utf8(value: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value)
  } catch {
    throw new RuntimeBackupError("invalid")
  }
}

function checksum(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function decode<A>(schema: Schema.Decoder<A>, value: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
  } catch {
    throw new RuntimeBackupError("invalid")
  }
}

function safe(error: unknown) {
  return error instanceof RuntimeBackupError ? error : new RuntimeBackupError("unavailable")
}
