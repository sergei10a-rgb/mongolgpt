import { recordPaymentDeadLetter } from "@mongolgpt/console-core/payment-recovery.js"

type RecordDeadLetter = (input: { body: unknown; now?: number }) => Promise<{
  id: string
  status: string
  validEvent: boolean
  changed: boolean
}>
type QueueBatch = {
  messages: ReadonlyArray<{
    body: unknown
    ack(): void
    retry(): void
  }>
}

export function createPaymentDeadLetterConsumer(
  record: RecordDeadLetter = recordPaymentDeadLetter,
  now: () => number = Date.now,
) {
  return {
    async queue(batch: QueueBatch) {
      for (const message of batch.messages) {
        try {
          const recovery = await record({ body: message.body, now: now() })
          console.warn("Төлбөрийн event recovery бүртгэлд шилжлээ", {
            recoveryID: recovery.id,
            status: recovery.status,
            validEvent: recovery.validEvent,
            changed: recovery.changed,
          })
          message.ack()
        } catch (error) {
          console.error("Төлбөрийн dead-letter event-ийг recovery бүртгэлд хадгалж чадсангүй", {
            error: error instanceof Error ? error.name : typeof error,
          })
          message.retry()
        }
      }
    },
  }
}

export default createPaymentDeadLetterConsumer()
