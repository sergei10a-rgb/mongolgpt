import { recordPaymentDeadLetter } from "@mongolgpt/console-core/payment-recovery.js"
import { Resource } from "sst"
import { archivePaymentDeadLetter, type PaymentRecoveryArchiveBucket } from "./payment-recovery-archive"

type RecordDeadLetter = (input: { body: unknown; now?: number }) => Promise<{
  id: string
  status: string
  validEvent: boolean
  changed: boolean
}>
type ArchiveDeadLetter = (input: { body: unknown; now: number }) => Promise<{
  key: string
  messageHash: string
}>
type QueueBatch = {
  messages: ReadonlyArray<{
    body: unknown
    ack(): void
    retry(): void
  }>
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated SST types gain this binding after deploy
const resources = Resource as unknown as {
  PaymentRecoveryArchive: PaymentRecoveryArchiveBucket
}

const archiveToLinkedBucket: ArchiveDeadLetter = (input) =>
  archivePaymentDeadLetter({ ...input, bucket: resources.PaymentRecoveryArchive })

export function createPaymentDeadLetterConsumer(
  record: RecordDeadLetter = recordPaymentDeadLetter,
  now: () => number = Date.now,
  archive: ArchiveDeadLetter = archiveToLinkedBucket,
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
          try {
            const receipt = await archive({ body: message.body, now: now() })
            console.warn("Төлбөрийн dead-letter event-ийг R2 recovery archive-д хадгаллаа", {
              archiveKey: receipt.key,
              messageHash: receipt.messageHash,
              databaseError: error instanceof Error ? error.name : typeof error,
            })
            message.ack()
          } catch (archiveError) {
            console.error("Төлбөрийн dead-letter event-ийг recovery хадгалалтад шилжүүлж чадсангүй", {
              databaseError: error instanceof Error ? error.name : typeof error,
              archiveError: archiveError instanceof Error ? archiveError.name : typeof archiveError,
            })
            message.retry()
          }
        }
      }
    },
  }
}

export default createPaymentDeadLetterConsumer()
