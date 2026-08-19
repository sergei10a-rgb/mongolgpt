import { z } from "zod"

export const USAGE_QUEUE_HEARTBEAT_TYPE = "usage-queue-heartbeat" as const
export const USAGE_QUEUE_HEARTBEAT_VERSION = 1 as const
export const USAGE_QUEUE_READINESS_KEY = "usage-queue:last-processed"
export const USAGE_QUEUE_READINESS_TTL_SECONDS = 15 * 60
export const USAGE_QUEUE_READINESS_MAX_AGE_MS = USAGE_QUEUE_READINESS_TTL_SECONDS * 1_000

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)

export const UsageQueueHeartbeatSchema = z
  .object({
    type: z.literal(USAGE_QUEUE_HEARTBEAT_TYPE),
    version: z.literal(USAGE_QUEUE_HEARTBEAT_VERSION),
    id: z.string().trim().min(1).max(128),
    sentAt: timestamp,
  })
  .strict()

export const UsageQueueHeartbeatEvidenceSchema = z
  .object({
    version: z.literal(USAGE_QUEUE_HEARTBEAT_VERSION),
    id: z.string().trim().min(1).max(128),
    sentAt: timestamp,
    processedAt: timestamp,
  })
  .strict()

export type UsageQueueHeartbeat = z.infer<typeof UsageQueueHeartbeatSchema>
export type UsageQueueHeartbeatEvidence = z.infer<typeof UsageQueueHeartbeatEvidenceSchema>

export function createUsageQueueHeartbeat(
  now: () => number = Date.now,
  id: () => string = () => crypto.randomUUID(),
): UsageQueueHeartbeat {
  return UsageQueueHeartbeatSchema.parse({
    type: USAGE_QUEUE_HEARTBEAT_TYPE,
    version: USAGE_QUEUE_HEARTBEAT_VERSION,
    id: id(),
    sentAt: now(),
  })
}

export function createUsageQueueHeartbeatEvidence(
  heartbeat: UsageQueueHeartbeat,
  processedAt: number,
): UsageQueueHeartbeatEvidence {
  const evidence = UsageQueueHeartbeatEvidenceSchema.parse({
    version: heartbeat.version,
    id: heartbeat.id,
    sentAt: heartbeat.sentAt,
    processedAt,
  })
  if (evidence.processedAt < evidence.sentAt) {
    throw new TypeError(
      "Хэрэглээний дарааллын хяналтын дохиог илгээхээс өмнө боловсруулсан мэт хугацаа бүртгэгдсэн байна",
    )
  }
  return evidence
}
