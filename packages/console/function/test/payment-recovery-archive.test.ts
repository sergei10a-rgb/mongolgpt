import { describe, expect, test } from "bun:test"
import { createPaymentQueueEvent } from "@mongolgpt/console-core/payment-queue.js"
import {
  archivePaymentDeadLetter,
  drainPaymentRecoveryArchive,
  PAYMENT_RECOVERY_ARCHIVE_PREFIX,
  paymentRecoveryArchiveKey,
  type PaymentRecoveryArchiveBucket,
} from "../src/payment-recovery-archive"

class MemoryBucket implements PaymentRecoveryArchiveBucket {
  readonly objects = new Map<string, string>()

  async put(key: string, value: string) {
    this.objects.set(key, value)
    return { etag: `etag-${key}`, size: new TextEncoder().encode(value).byteLength }
  }

  async list(input: { prefix: string; limit: number }) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(input.prefix))
      .slice(0, input.limit)
      .map(([key, value]) => ({ key, size: new TextEncoder().encode(value).byteLength }))
    return { objects, truncated: this.objects.size > objects.length }
  }

  async get(key: string) {
    const value = this.objects.get(key)
    if (value === undefined) return null
    return {
      size: new TextEncoder().encode(value).byteLength,
      async text() {
        return value
      },
    }
  }

  async delete(key: string) {
    this.objects.delete(key)
  }
}

describe("payment recovery R2 archive", () => {
  test("stores a content-addressed envelope and imports it idempotently into D1 recovery", async () => {
    const bucket = new MemoryBucket()
    const body = createPaymentQueueEvent(
      {
        provider: "qpay",
        merchantAccountID: "merchant_archive",
        externalEventID: "event_archive",
        externalInvoiceID: "invoice_archive",
        externalPaymentID: "payment_archive",
        amount: 39_000,
        currency: "MNT",
        type: "paid",
        payloadHash: "a".repeat(64),
        occurredAt: 122,
      },
      123,
    )
    const receipt = await archivePaymentDeadLetter({ body, now: 123, bucket })
    expect(receipt.key).toBe(paymentRecoveryArchiveKey(receipt.messageHash))
    expect(receipt.key).toStartWith(PAYMENT_RECOVERY_ARCHIVE_PREFIX)
    expect(bucket.objects.has(receipt.key)).toBeTrue()

    const recorded: unknown[] = []
    const result = await drainPaymentRecoveryArchive({
      bucket,
      record: async (input) => {
        recorded.push(input)
      },
    })

    expect(result).toEqual({ imported: 1, failed: 0, missing: 0, truncated: false })
    expect(recorded).toEqual([{ body, now: 123, trustedMessageHash: receipt.messageHash }])
    expect(bucket.objects.size).toBe(0)
  })

  test("archives only a fingerprint for invalid bodies and never persists their raw secrets", async () => {
    const bucket = new MemoryBucket()
    const secret = "must-never-be-persisted"
    const receipt = await archivePaymentDeadLetter({ body: { version: 2, secret }, now: 234, bucket })
    const serialized = bucket.objects.get(receipt.key)
    expect(serialized).toBeString()
    expect(serialized).not.toContain(secret)

    const recorded: unknown[] = []
    const result = await drainPaymentRecoveryArchive({
      bucket,
      record: async (input) => {
        recorded.push(input)
      },
    })

    expect(result).toEqual({ imported: 1, failed: 0, missing: 0, truncated: false })
    expect(recorded).toEqual([{ body: undefined, now: 234, trustedMessageHash: receipt.messageHash }])
    expect(bucket.objects.size).toBe(0)
  })

  test("keeps corrupt or temporarily unpersistable objects for operator recovery", async () => {
    const bucket = new MemoryBucket()
    const body = { version: 1, event: { id: "evt_retry" } }
    const receipt = await archivePaymentDeadLetter({ body, now: 456, bucket })
    const corruptKey = `${PAYMENT_RECOVERY_ARCHIVE_PREFIX}aa/${"a".repeat(64)}.json`
    bucket.objects.set(corruptKey, "{}")

    const result = await drainPaymentRecoveryArchive({
      bucket,
      record: async () => {
        throw new Error("D1 unavailable")
      },
    })

    expect(result).toEqual({ imported: 0, failed: 2, missing: 0, truncated: false })
    expect(bucket.objects.has(receipt.key)).toBeTrue()
    expect(bucket.objects.has(corruptKey)).toBeTrue()
  })
})
