import {
  PaymentQueueEventSchema,
  applyPaymentQueueEvent,
  type PaymentQueueEvent,
} from "@mongolgpt/console-core/payment-queue.js"

type ApplyPayment = (event: PaymentQueueEvent) => Promise<unknown>
type QueueBatch = {
  messages: ReadonlyArray<{
    body: unknown
    ack(): void
    retry(): void
  }>
}

export function createPaymentQueueConsumer(apply: ApplyPayment = applyPaymentQueueEvent) {
  return {
    async queue(batch: QueueBatch) {
      for (const message of batch.messages) {
        const parsed = PaymentQueueEventSchema.safeParse(message.body)
        if (!parsed.success) {
          console.error("Payment queue message validation failed")
          message.retry()
          continue
        }

        try {
          await apply(parsed.data)
          message.ack()
        } catch (error) {
          console.error("Payment queue event failed", {
            provider: parsed.data.event.provider,
            externalEventID: parsed.data.event.externalEventID,
            error: error instanceof Error ? error.name : typeof error,
          })
          message.retry()
        }
      }
    },
  }
}

export default createPaymentQueueConsumer()
