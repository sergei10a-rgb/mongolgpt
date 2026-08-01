import { processEligibleAccountDeletions } from "@mongolgpt/console-core/account-deletion.js"

const BATCH_SIZE = 50
const MAX_BATCHES = 10

type ProcessBatch = typeof processEligibleAccountDeletions

export async function runAccountDeletionRetention(
  now: number,
  processBatch: ProcessBatch = processEligibleAccountDeletions,
) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Account deletion retention time is invalid")

  let processed = 0
  let failed = 0
  let skipped = 0
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const result = await processBatch({ now, limit: BATCH_SIZE })
    const counts = [result.processed, result.failed, result.skipped]
    if (
      counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      result.processed + result.failed + result.skipped > BATCH_SIZE
    ) {
      throw new Error("Account deletion retention batch result is invalid")
    }
    processed += result.processed
    failed += result.failed
    skipped += result.skipped
    if (!result.truncated) return { processed, failed, skipped, truncated: false }
  }
  return { processed, failed, skipped, truncated: true }
}

export default {
  async scheduled(controller: { scheduledTime: number }) {
    const result = await runAccountDeletionRetention(controller.scheduledTime)
    console.log("Account deletion retention completed", result)
  },
}
