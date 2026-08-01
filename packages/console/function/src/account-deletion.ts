import {
  processEligibleAccountDeletions,
  purgeCompletedAccountDeletions,
} from "@mongolgpt/console-core/account-deletion.js"

const BATCH_SIZE = 50
const MAX_BATCHES = 10

type ProcessBatch = typeof processEligibleAccountDeletions
type PurgeBatch = typeof purgeCompletedAccountDeletions

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

export async function runAccountDeletionPurge(now: number, purgeBatch: PurgeBatch = purgeCompletedAccountDeletions) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Account deletion purge time is invalid")

  let purged = 0
  let skipped = 0
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const result = await purgeBatch({ now, limit: BATCH_SIZE })
    const counts = [result.purged, result.skipped]
    if (
      counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      result.purged + result.skipped > BATCH_SIZE
    ) {
      throw new Error("Account deletion purge batch result is invalid")
    }
    purged += result.purged
    skipped += result.skipped
    if (!result.truncated) return { purged, skipped, truncated: false }
  }
  return { purged, skipped, truncated: true }
}

export default {
  async scheduled(controller: { scheduledTime: number }) {
    const retention = await runAccountDeletionRetention(controller.scheduledTime)
    const purge = await runAccountDeletionPurge(controller.scheduledTime)
    console.log("Account deletion retention completed", { retention, purge })
  },
}
