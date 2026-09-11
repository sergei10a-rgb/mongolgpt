export { createSubscriptionCheckout, expireOpenPaymentCheckouts } from "../../src/payment-checkout"
export { PaymentProviderResponseError } from "../../src/payment-provider"
export { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import type { D1Database } from "@cloudflare/workers-types"

const schema = await import("../../src/schema-d1")
export function createDatabase(binding: D1Database) {
  return drizzle(binding, { schema })
}
