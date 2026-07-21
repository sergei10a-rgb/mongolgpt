import { expirePlanSubscriptions } from "@mongolgpt/console-core/payment-entitlement.js"

const BATCH_SIZE = 100
const MAX_BATCHES = 10

type ExpireBatch = (now: number, limit: number) => Promise<number>

export async function runSubscriptionExpiration(now: number, expire: ExpireBatch = expirePlanSubscriptions) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Subscription expiration time is invalid")

  let processed = 0
  let batches = 0
  while (batches < MAX_BATCHES) {
    const count = await expire(now, BATCH_SIZE)
    if (!Number.isSafeInteger(count) || count < 0 || count > BATCH_SIZE) {
      throw new Error("Subscription expiration batch result is invalid")
    }
    processed += count
    batches++
    if (count < BATCH_SIZE) return { processed, truncated: false }
  }
  return { processed, truncated: true }
}

export default {
  async scheduled(controller: { scheduledTime: number }) {
    const result = await runSubscriptionExpiration(controller.scheduledTime)
    console.log("Plan subscription expiration completed", result)
  },
}
