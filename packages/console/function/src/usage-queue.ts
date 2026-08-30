import { UsageQueueEventSchema, type UsageQueueEvent } from "@mongolgpt/console-core/quota.js"
import { persistUsageQueueEvent } from "@mongolgpt/console-core/usage-queue.js"
import {
  createUsageQueueHeartbeatEvidence,
  USAGE_QUEUE_HEARTBEAT_TYPE,
  USAGE_QUEUE_READINESS_TTL_SECONDS,
  usageQueueReadinessKey,
  UsageQueueStageSchema,
  UsageQueueHeartbeatSchema,
  type UsageQueueHeartbeat,
} from "@mongolgpt/console-core/usage-queue-readiness.js"
import { Resource } from "@mongolgpt/console-resource"
import type { KVNamespace } from "@cloudflare/workers-types"
import {
  persistProviderAttempt,
  ProviderAttemptEventSchema,
  type ProviderAttemptEvent,
} from "@mongolgpt/console-core/provider-health.js"

type QueueMessage = {
  body: unknown
  ack(): void
  retry(): void
}

type QueueBatch = { messages: ReadonlyArray<QueueMessage> }
type ReadinessKV = Pick<KVNamespace, "put">
const HeartbeatEnvelopeSchema = UsageQueueHeartbeatSchema.pick({ type: true }).passthrough()

export async function recordUsageQueueHeartbeat(
  readiness: ReadinessKV,
  heartbeat: UsageQueueHeartbeat,
  expectedStage: string,
  processedAt = Date.now(),
) {
  const stage = UsageQueueStageSchema.parse(expectedStage)
  if (heartbeat.stage !== stage) throw new TypeError("Хэрэглээний дарааллын хяналтын дохионы орчин зөрж байна")
  const evidence = createUsageQueueHeartbeatEvidence(heartbeat, processedAt)
  const serialized = JSON.stringify(evidence)
  await readiness.put(usageQueueReadinessKey(stage), serialized, { expirationTtl: USAGE_QUEUE_READINESS_TTL_SECONDS })
  return serialized
}

export function createUsageQueueConsumer(
  persist: (event: UsageQueueEvent) => Promise<unknown> = persistUsageQueueEvent,
  readiness?: ReadinessKV,
  now: () => number = Date.now,
  stage?: string,
  persistAttempt: (event: ProviderAttemptEvent) => Promise<unknown> = persistProviderAttempt,
) {
  return {
    async queue(batch: QueueBatch) {
      const expectedStage = UsageQueueStageSchema.parse(stage ?? Resource.App.stage)
      for (const message of batch.messages) {
        const heartbeat = UsageQueueHeartbeatSchema.safeParse(message.body)
        if (heartbeat.success) {
          if (heartbeat.data.stage !== expectedStage) {
            console.error("Хэрэглээний дарааллын өөр орчны хяналтын дохиог орхилоо")
            message.ack()
            continue
          }
          try {
            await recordUsageQueueHeartbeat(
              readiness ?? Resource.UsageQueueReadiness,
              heartbeat.data,
              expectedStage,
              now(),
            )
            message.ack()
          } catch (error) {
            console.error("Хэрэглээний дарааллын хяналтын дохиог бэлэн байдлын KV-д хадгалж чадсангүй", {
              error: error instanceof Error ? error.name : typeof error,
            })
            message.retry()
          }
          continue
        }

        const control = HeartbeatEnvelopeSchema.safeParse(message.body)
        if (control.success && control.data.type === USAGE_QUEUE_HEARTBEAT_TYPE) {
          console.error("Хэрэглээний дарааллын хуучин эсвэл буруу хяналтын дохиог орхилоо")
          message.ack()
          continue
        }

        const providerAttempt = ProviderAttemptEventSchema.safeParse(message.body)
        if (providerAttempt.success) {
          try {
            await persistAttempt(providerAttempt.data)
            message.ack()
          } catch (error) {
            console.error("Нийлүүлэгчийн оролдлогыг хадгалж чадсангүй", {
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
