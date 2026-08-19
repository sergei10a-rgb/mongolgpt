import { processPaymentRecoveries } from "@mongolgpt/console-core/payment-recovery.js"
import { createPaymentEntitlementApply } from "./payment-queue"

const BATCH_SIZE = 50
const MAX_BATCHES = 10

type ProcessBatch = (input: { now: number; limit?: number }) => Promise<{
  resolved: number
  retried: number
  manualReview: number
  skipped: number
  truncated: boolean
}>

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
    const result = await runPaymentRecovery(controller.scheduledTime)
    console.log("Төлбөрийн recovery боловсруулалт дууслаа", result)
  },
}
