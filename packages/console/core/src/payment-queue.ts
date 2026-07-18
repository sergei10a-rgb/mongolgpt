import {
  ApplyPaymentEventSchema,
  applyPaymentEvent,
  applyPaymentEventWithDb,
  type ApplyPaymentEventInput,
  type PaymentTransitionEffect,
} from "./payment-ledger"
import { Database } from "./drizzle"
import { z } from "zod"

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)

export const PaymentQueueEventSchema = z
  .object({
    version: z.literal(1),
    event: ApplyPaymentEventSchema,
    enqueuedAt: timestamp,
  })
  .strict()

export type PaymentQueueEvent = z.infer<typeof PaymentQueueEventSchema>

export function createPaymentQueueEvent(event: ApplyPaymentEventInput, enqueuedAt = Date.now()) {
  return PaymentQueueEventSchema.parse({
    version: 1,
    event,
    enqueuedAt,
  })
}

export function applyPaymentQueueEventWithDb(
  db: Database.TxOrDb,
  input: PaymentQueueEvent,
  effect?: PaymentTransitionEffect,
) {
  const message = PaymentQueueEventSchema.parse(input)
  return applyPaymentEventWithDb(db, message.event, effect)
}

export function applyPaymentQueueEvent(input: PaymentQueueEvent, effect?: PaymentTransitionEffect) {
  const message = PaymentQueueEventSchema.parse(input)
  return applyPaymentEvent(message.event, effect)
}
