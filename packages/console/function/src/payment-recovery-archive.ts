import { paymentRecoveryFingerprint } from "@mongolgpt/console-core/payment-recovery.js"
import { PaymentQueueEventSchema } from "@mongolgpt/console-core/payment-queue.js"

export const PAYMENT_RECOVERY_ARCHIVE_PREFIX = "payment-recovery/v1/"
export const PAYMENT_RECOVERY_ARCHIVE_MAX_BYTES = 256 * 1024

export type PaymentRecoveryArchiveBucket = {
  put(
    key: string,
    value: string,
    options: {
      httpMetadata: { contentType: string }
      customMetadata: Record<string, string>
    },
  ): Promise<{ etag: string; size: number } | null>
  list(options: { prefix: string; limit: number }): Promise<{
    objects: ReadonlyArray<{ key: string; size: number }>
    truncated: boolean
  }>
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>
  delete(key: string): Promise<void>
}

type RecordDeadLetter = (input: { body: unknown; now?: number; trustedMessageHash?: string }) => Promise<unknown>

type ArchiveEnvelope = {
  version: 1
  kind: "mongolgpt-payment-recovery"
  messageHash: string
  archivedAt: number
  validEvent: boolean
  body?: unknown
}

export async function archivePaymentDeadLetter(input: {
  body: unknown
  now: number
  bucket: Pick<PaymentRecoveryArchiveBucket, "put">
}) {
  const archivedAt = timestamp(input.now)
  const parsed = PaymentQueueEventSchema.safeParse(input.body)
  const body = parsed.success ? parsed.data : undefined
  const messageHash = await paymentRecoveryFingerprint(parsed.success ? body : input.body)
  const key = paymentRecoveryArchiveKey(messageHash)
  const envelope: ArchiveEnvelope = {
    version: 1,
    kind: "mongolgpt-payment-recovery",
    messageHash,
    archivedAt,
    validEvent: parsed.success,
    ...(parsed.success ? { body } : {}),
  }
  const serialized = serializeEnvelope(envelope)
  const stored = await input.bucket.put(key, serialized, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      kind: envelope.kind,
      version: String(envelope.version),
      messageHash,
      archivedAt: new Date(archivedAt).toISOString(),
    },
  })
  const size = new TextEncoder().encode(serialized).byteLength
  if (!stored || !stored.etag || stored.size !== size) {
    throw new Error("Төлбөрийн recovery R2 archive-ийг баталгаажуулсангүй")
  }
  return { key, messageHash, size, etag: stored.etag }
}

export async function drainPaymentRecoveryArchive(input: {
  bucket: PaymentRecoveryArchiveBucket
  record: RecordDeadLetter
  limit?: number
}) {
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Төлбөрийн recovery archive багцын хязгаар буруу байна")
  }
  const listed = await input.bucket.list({ prefix: PAYMENT_RECOVERY_ARCHIVE_PREFIX, limit })
  let imported = 0
  let failed = 0
  let missing = 0

  for (const object of listed.objects) {
    try {
      const stored = await input.bucket.get(object.key)
      if (!stored) {
        missing++
        continue
      }
      if (!Number.isSafeInteger(stored.size) || stored.size <= 0 || stored.size > PAYMENT_RECOVERY_ARCHIVE_MAX_BYTES) {
        throw new Error("Төлбөрийн recovery archive объектын хэмжээ буруу байна")
      }
      const serialized = await stored.text()
      if (new TextEncoder().encode(serialized).byteLength !== stored.size) {
        throw new Error("Төлбөрийн recovery archive объектын хэмжээ зөрлөө")
      }
      const envelope = parseEnvelope(serialized)
      if (object.key !== paymentRecoveryArchiveKey(envelope.messageHash)) {
        throw new Error("Төлбөрийн recovery archive түлхүүр зөрлөө")
      }
      if (envelope.validEvent) {
        const fingerprint = await paymentRecoveryFingerprint(envelope.body)
        if (fingerprint !== envelope.messageHash) {
          throw new Error("Төлбөрийн recovery archive fingerprint зөрлөө")
        }
      }
      await input.record({
        body: envelope.validEvent ? envelope.body : undefined,
        now: envelope.archivedAt,
        trustedMessageHash: envelope.messageHash,
      })
      await input.bucket.delete(object.key)
      imported++
    } catch {
      failed++
    }
  }

  return { imported, failed, missing, truncated: listed.truncated }
}

export function paymentRecoveryArchiveKey(messageHash: string) {
  if (!/^[a-f0-9]{64}$/.test(messageHash)) {
    throw new TypeError("Төлбөрийн recovery archive fingerprint буруу байна")
  }
  return `${PAYMENT_RECOVERY_ARCHIVE_PREFIX}${messageHash.slice(0, 2)}/${messageHash}.json`
}

function serializeEnvelope(envelope: ArchiveEnvelope) {
  let serialized: string
  try {
    serialized = JSON.stringify(envelope)
  } catch {
    throw new Error("Төлбөрийн recovery archive мессежийг serialize хийж чадсангүй")
  }
  const size = new TextEncoder().encode(serialized).byteLength
  if (size <= 0 || size > PAYMENT_RECOVERY_ARCHIVE_MAX_BYTES) {
    throw new Error("Төлбөрийн recovery archive мессежийн хэмжээ буруу байна")
  }
  return serialized
}

function parseEnvelope(serialized: string): ArchiveEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error("Төлбөрийн recovery archive JSON буруу байна")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Төлбөрийн recovery archive envelope буруу байна")
  }
  const value = parsed as Record<string, unknown>
  if (
    value.version !== 1 ||
    value.kind !== "mongolgpt-payment-recovery" ||
    typeof value.messageHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.messageHash) ||
    typeof value.archivedAt !== "number" ||
    typeof value.validEvent !== "boolean"
  ) {
    throw new Error("Төлбөрийн recovery archive envelope буруу байна")
  }
  const body = value.validEvent ? PaymentQueueEventSchema.safeParse(value.body) : undefined
  if (value.validEvent && !body?.success) {
    throw new Error("Төлбөрийн recovery archive event буруу байна")
  }
  if (!value.validEvent && Object.hasOwn(value, "body")) {
    throw new Error("Төлбөрийн recovery archive буруу body-той байна")
  }
  return {
    version: 1,
    kind: "mongolgpt-payment-recovery",
    messageHash: value.messageHash,
    archivedAt: timestamp(value.archivedAt),
    validEvent: value.validEvent,
    ...(body?.success ? { body: body.data } : {}),
  }
}

function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new TypeError("Төлбөрийн recovery archive хугацаа буруу байна")
  }
  return value
}
