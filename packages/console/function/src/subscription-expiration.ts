import { expirePlanSubscriptions } from "@mongolgpt/console-core/payment-entitlement.js"
import { expireOpenPaymentCheckouts } from "@mongolgpt/console-core/payment-checkout.js"

const BATCH_SIZE = 100
const MAX_BATCHES = 10

type ExpireBatch = (now: number, limit: number) => Promise<number>

export async function runSubscriptionExpiration(now: number, expire: ExpireBatch = expirePlanSubscriptions) {
  return drainExpirationBatches("Subscription", now, expire)
}

export async function runPaymentCheckoutExpiration(now: number, expire: ExpireBatch = expireOpenPaymentCheckouts) {
  return drainExpirationBatches("Payment checkout", now, expire)
}

export async function runBillingExpiration(
  now: number,
  dependencies: { subscriptions?: ExpireBatch; checkouts?: ExpireBatch } = {},
) {
  const subscriptions = await runSubscriptionExpiration(now, dependencies.subscriptions)
  const checkouts = await runPaymentCheckoutExpiration(now, dependencies.checkouts)
  return { subscriptions, checkouts }
}

async function drainExpirationBatches(name: string, now: number, expire: ExpireBatch) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError(`${name} expiration time is invalid`)

  let processed = 0
  let batches = 0
  while (batches < MAX_BATCHES) {
    const count = await expire(now, BATCH_SIZE)
    if (!Number.isSafeInteger(count) || count < 0 || count > BATCH_SIZE) {
      throw new Error(`${name} expiration batch result is invalid`)
    }
    processed += count
    batches++
    if (count < BATCH_SIZE) return { processed, truncated: false }
  }
  return { processed, truncated: true }
}

export default {
  async scheduled(controller: { scheduledTime: number }) {
    const result = await runBillingExpiration(controller.scheduledTime)
    console.log("Billing expiration completed", result)
  },
}
