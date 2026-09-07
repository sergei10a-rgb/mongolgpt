import { createDecipheriv, createHash } from "node:crypto"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { createRuntimeBackupStore, deriveRuntimeBackupKey, RuntimeBackupError } from "./backup"
import { decodeCheckpoint, decodeFileRevision } from "./checkpoint-contract"
import { createHistoryStore, type HistoryLease, type HistoryScope } from "./history"

const magic = new TextEncoder().encode("MONGOLGPT-SQLITE-BACKUP\0\x01")
const headerBytes = magic.byteLength + 12
const tagBytes = 16

/** Internal bootstrap boundary, not a public RPC. Inventory comes from the native
 * restored-SQLite inspector. This binds its receipt to tenant-authenticated R2 bytes.
 * Consumers must restore that baseline and replay later deletions before exposure.
 */
export function createRuntimeCheckpointStore(
  db: Pick<D1Database, "prepare" | "batch">,
  bucket: Pick<R2Bucket, "put" | "get">,
  masters: Readonly<Record<string, Uint8Array>>,
) {
  const history = createHistoryStore(db)
  const backups = createRuntimeBackupStore(bucket)

  async function verify(scope: HistoryScope, ref: CloudCheckpoint.Archive) {
    const master = masters[ref.keyID]
    if (!(master instanceof Uint8Array)) throw new RuntimeBackupError("unavailable")
    const key = deriveRuntimeBackupKey(scope, ref.keyID, master)
    try {
      const archive = await backups.open(scope, ref.backupID)
      const reader = archive.body.getReader()
      try {
        if (
          archive.manifest.keyID !== ref.keyID ||
          archive.manifest.bytes !== ref.bytes ||
          archive.manifest.sha256 !== ref.sha256
        )
          throw new RuntimeBackupError("invalid")
        const first = await reader.read()
        if (
          first.done ||
          first.value.byteLength < headerBytes ||
          magic.some((byte, index) => first.value[index] !== byte)
        )
          throw new RuntimeBackupError("invalid")
        const header = first.value.subarray(0, headerBytes)
        const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(magic.byteLength))
        decipher.setAAD(header)
        const authTag = await archive.authTag()
        decipher.setAuthTag(authTag)
        const hash = createHash("sha256")
        let bytes = 0
        let tail: Uint8Array = new Uint8Array()
        function hashPlaintext(value: Uint8Array) {
          try {
            bytes += value.byteLength
            if (bytes > ref.plaintext.bytes) throw new RuntimeBackupError("invalid")
            hash.update(value)
          } finally {
            value.fill(0)
          }
        }
        function consume(value: Uint8Array) {
          const joined = Buffer.concat([tail, value])
          const end = Math.max(0, joined.byteLength - tagBytes)
          if (end) hashPlaintext(decipher.update(joined.subarray(0, end)))
          tail = joined.subarray(end)
        }
        consume(first.value.subarray(headerBytes))
        while (true) {
          const item = await reader.read()
          if (item.done) break
          consume(item.value)
        }
        if (tail.byteLength !== tagBytes || tail.some((byte, index) => byte !== authTag[index]))
          throw new RuntimeBackupError("invalid")
        // No plaintext is exposed or D1 state published before GCM final succeeds.
        try {
          hashPlaintext(decipher.final())
        } catch {
          throw new RuntimeBackupError("invalid")
        }
        if (bytes !== ref.plaintext.bytes || hash.digest("hex") !== ref.plaintext.sha256)
          throw new RuntimeBackupError("invalid")
      } finally {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    } catch (error) {
      throw error instanceof RuntimeBackupError ? error : new RuntimeBackupError("unavailable")
    } finally {
      key.fill(0)
    }
  }

  async function publish(writer: HistoryLease, input: CloudCheckpoint.Checkpoint) {
    const lease = { ...writer }
    const scope = { accountID: lease.accountID, workspaceID: lease.workspaceID }
    const data = decodeCheckpoint(input)
    await verify(scope, data.sqlite)
    await verify(scope, data.files)
    return history.publishCheckpoint(lease, data)
  }

  async function read(tenant: HistoryScope) {
    const scope = { ...tenant }
    const checkpoint = await history.checkpoint(scope)
    if (!checkpoint) return undefined
    await verify(scope, checkpoint.data.sqlite)
    await verify(scope, checkpoint.data.files)
    return checkpoint
  }

  async function publishFiles(writer: HistoryLease, input: CloudCheckpoint.FileRevision) {
    const lease = { ...writer }
    const data = decodeFileRevision(input)
    await verify({ accountID: lease.accountID, workspaceID: lease.workspaceID }, data.archive)
    return history.publishFiles(lease, data)
  }

  async function readFiles(tenant: HistoryScope) {
    const scope = { ...tenant }
    const revision = await history.fileRevision(scope)
    if (!revision) return undefined
    await verify(scope, revision.data.archive)
    return revision
  }

  return { publish, read, publishFiles, readFiles }
}
