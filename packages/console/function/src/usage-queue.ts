import { UsageQueueEventSchema, type UsageQueueEvent } from "@mongolgpt/console-core/quota.js"
import { persistUsageQueueEvent } from "@mongolgpt/console-core/usage-queue.js"
import {
  createUsageQueueHeartbeatEvidence,
  USAGE_QUEUE_READINESS_KEY,
  USAGE_QUEUE_READINESS_TTL_SECONDS,
  UsageQueueHeartbeatSchema,
  type UsageQueueHeartbeat,
} from "@mongolgpt/console-core/usage-queue-readiness.js"
import { Resource } from "@mongolgpt/console-resource"
import type { KVNamespace } from "@cloudflare/workers-types"

type QueueMessage = {
  body: unknown
  ack(): void
  retry(): void
}

type QueueBatch = { messages: ReadonlyArray<QueueMessage> }
type ReadinessKV = Pick<KVNamespace, "put">

export async function recordUsageQueueHeartbeat(
  readiness: ReadinessKV,
  heartbeat: UsageQueueHeartbeat,
  processedAt = Date.now(),
) {
  const evidence = createUsageQueueHeartbeatEvidence(heartbeat, processedAt)
  const serialized = JSON.stringify(evidence)
  await readiness.put(USAGE_QUEUE_READINESS_KEY, serialized, { expirationTtl: USAGE_QUEUE_READINESS_TTL_SECONDS })
  return serialized
}

export function createUsageQueueConsumer(
  persist: (event: UsageQueueEvent) => Promise<unknown> = persistUsageQueueEvent,
  readiness?: ReadinessKV,
  now: () => number = Date.now,
) {
  return {
    async queue(batch: QueueBatch) {
      for (const message of batch.messages) {
        const heartbeat = UsageQueueHeartbeatSchema.safeParse(message.body)
        if (heartbeat.success) {
          try {
            await recordUsageQueueHeartbeat(readiness ?? Resource.UsageQueueReadiness, heartbeat.data, now())
            message.ack()
          } catch (error) {
            console.error("Хэрэглээний дарааллын хяналтын дохиог бэлэн байдлын KV-д хадгалж чадсангүй", {
              error: error instanceof Error ? error.name : typeof error,
            })
            message.retry()
          }
          continue
        }

        const usage = UsageQueueEventSchema.safeParse(message.body)
        if (!usage.success) {
          console.error("Хэрэглээний дарааллын зурвасын бүтэц буруу байна")
          message.retry()
          continue
        }

        try {
          await persist(usage.data)
          message.ack()
        } catch (error) {
          console.error("Хэрэглээний дарааллын үйл явдлыг боловсруулахад алдаа гарлаа", {
            error: error instanceof Error ? error.name : typeof error,
          })
          message.retry()
        }
      }
    },
  }
}

export default createUsageQueueConsumer()
