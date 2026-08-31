import { processPaymentRecoveries, recordPaymentDeadLetter } from "@mongolgpt/console-core/payment-recovery.js"
import { Resource } from "sst"
import { createPaymentEntitlementApply } from "./payment-queue"
import { drainPaymentRecoveryArchive, type PaymentRecoveryArchiveBucket } from "./payment-recovery-archive"

const BATCH_SIZE = 50
const MAX_BATCHES = 10

type ProcessBatch = (input: { now: number; limit?: number }) => Promise<{
  resolved: number
  retried: number
  manualReview: number
  skipped: number
  truncated: boolean
}>
type DrainArchive = (input: { limit: number }) => Promise<{
  imported: number
  failed: number
  missing: number
  truncated: boolean
}>

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated SST types gain this binding after deploy
const resources = Resource as unknown as {
  PaymentRecoveryArchive: PaymentRecoveryArchiveBucket
}

const drainLinkedArchive: DrainArchive = (input) =>
  drainPaymentRecoveryArchive({
    ...input,
    bucket: resources.PaymentRecoveryArchive,
    record: recordPaymentDeadLetter,
  })

export async function runPaymentRecoveryArchive(drain: DrainArchive = drainLinkedArchive) {
  const result = await drain({ limit: BATCH_SIZE })
  const counts = [result.imported, result.failed, result.missing]
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    result.imported + result.failed + result.missing > BATCH_SIZE
  ) {
    throw new Error("Төлбөрийн recovery archive багцын үр дүн буруу байна")
  }
  return result
}

export async function runPaymentRecovery(
  now: number,
  processBatch: ProcessBatch = (input) =>
    processPaymentRecoveries(input, {
      apply: createPaymentEntitlementApply(),
    }),
) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Төлбөрийн recovery хугацаа буруу байна")

  let resolved = 0
  let retried = 0
  let manualReview = 0
  let skipped = 0
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const result = await processBatch({ now, limit: BATCH_SIZE })
    const counts = [result.resolved, result.retried, result.manualReview, result.skipped]
    if (
      counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      result.resolved + result.retried + result.manualReview + result.skipped > BATCH_SIZE
    ) {
      throw new Error("Төлбөрийн recovery багцын үр дүн буруу байна")
    }
    resolved += result.resolved
    retried += result.retried
    manualReview += result.manualReview
    skipped += result.skipped
    if (!result.truncated) return { resolved, retried, manualReview, skipped, truncated: false }
  }
  return { resolved, retried, manualReview, skipped, truncated: true }
}

export default {
  async scheduled(controller: { scheduledTime: number }) {
    let archive:
      | Awaited<ReturnType<typeof runPaymentRecoveryArchive>>
      | { imported: 0; failed: 1; missing: 0; truncated: true }
    try {
      archive = await runPaymentRecoveryArchive()
    } catch (error) {
      archive = { imported: 0, failed: 1, missing: 0, truncated: true }
      console.error("Төлбөрийн recovery R2 archive-ийг уншиж чадсангүй", {
        error: error instanceof Error ? error.name : typeof error,
      })
    }
    const result = await runPaymentRecovery(controller.scheduledTime)
    console.log("Төлбөрийн recovery боловсруулалт дууслаа", { archive, database: result })
  },
}
