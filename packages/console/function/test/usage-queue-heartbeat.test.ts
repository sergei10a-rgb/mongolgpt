import { describe, expect, spyOn, test } from "bun:test"
import {
  createUsageQueueHeartbeat,
  usageQueueReadinessKey,
  UsageQueueHeartbeatSchema,
} from "@mongolgpt/console-core/usage-queue-readiness.js"
import { createUsageQueueConsumer, recordUsageQueueHeartbeat } from "../src/usage-queue"
import { createUsageQueueHeartbeatSender } from "../src/usage-queue-heartbeat"

function message(body: unknown) {
  let acknowledged = 0
  let retried = 0
  return {
    body,
    ack() {
      acknowledged++
    },
    retry() {
      retried++
    },
    result() {
      return { acknowledged, retried }
    },
  }
}

describe("Usage Queue freshness heartbeat", () => {
  test("creates a versioned, nonsecret heartbeat and sends it on schedule", async () => {
    const sent: unknown[] = []
    const heartbeat = await createUsageQueueHeartbeatSender(
      { send: async (value) => void sent.push(value) },
      "DEV",
      () => 1_800_000_000_000,
      () => "heartbeat-test-id",
    )()
    expect(heartbeat).toEqual({
      type: "usage-queue-heartbeat",
      version: 2,
      stage: "dev",
      id: "heartbeat-test-id",
      sentAt: 1_800_000_000_000,
    })
    expect(sent).toEqual([heartbeat])
    expect(UsageQueueHeartbeatSchema.safeParse(heartbeat).success).toBe(true)
  })

  test("stores bounded evidence and acknowledges only after KV succeeds", async () => {
    const writes: Array<[string, unknown, unknown?]> = []
    const heartbeat = createUsageQueueHeartbeat(
      "dev",
      () => 1_700_000_000_000,
      () => "id-1",
    )
    await recordUsageQueueHeartbeat(
      { put: async (...args) => void writes.push(args) },
      heartbeat,
      "dev",
      1_700_000_000_123,
    )
    expect(writes).toEqual([
      [
        usageQueueReadinessKey("dev"),
        '{"version":2,"stage":"dev","id":"id-1","sentAt":1700000000000,"processedAt":1700000000123}',
        { expirationTtl: 900 },
      ],
    ])
    expect(usageQueueReadinessKey("DEV")).toBe("usage-queue:dev:last-processed")
    expect(() => usageQueueReadinessKey("../production")).toThrow()

    await expect(
      recordUsageQueueHeartbeat({ put: async () => undefined }, heartbeat, "dev", heartbeat.sentAt - 1),
    ).rejects.toThrow("илгээхээс өмнө")
    await expect(
      recordUsageQueueHeartbeat({ put: async () => undefined }, heartbeat, "production", heartbeat.sentAt + 1),
    ).rejects.toThrow("орчин зөрж")
  })

  test("acks stage-bound heartbeats, drops legacy controls, retries KV failures, and preserves usage persistence", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    const heartbeat = createUsageQueueHeartbeat(
      "dev",
      () => 1_700_000_000_000,
      () => "id-2",
    )
    const valid = message(heartbeat)
    const invalid = message({ type: "usage-queue-heartbeat", version: 1, id: "bad", secret: "must-not-log" })
    const wrongStage = message({ ...heartbeat, stage: "production" })
    const failed = message(heartbeat)
    const persisted: unknown[] = []
    const consumer = createUsageQueueConsumer(
      async (event) => void persisted.push(event),
      {
        put: async () => undefined,
      },
      () => 1_700_000_000_100,
      "dev",
    )
    await consumer.queue({ messages: [valid, invalid, wrongStage] })

    const failedConsumer = createUsageQueueConsumer(
      async (event) => void persisted.push(event),
      {
        put: async () => {
          throw new Error("KV unavailable")
        },
      },
      () => 1_700_000_000_100,
      "dev",
    )
    await failedConsumer.queue({ messages: [failed] })
    expect(valid.result()).toEqual({ acknowledged: 1, retried: 0 })
    expect(invalid.result()).toEqual({ acknowledged: 1, retried: 0 })
    expect(wrongStage.result()).toEqual({ acknowledged: 1, retried: 0 })
    expect(failed.result()).toEqual({ acknowledged: 0, retried: 1 })
    expect(persisted).toEqual([])
    expect(error.mock.calls).toHaveLength(3)
    expect(JSON.stringify(error.mock.calls)).not.toContain("KV unavailable")
    expect(JSON.stringify(error.mock.calls)).not.toContain("must-not-log")
    error.mockRestore()
  })

  test("routes typed provider attempts to the idempotent health persistence path", async () => {
    const attempts: unknown[] = []
    const providerAttempt = {
      type: "provider-attempt",
      version: 1,
      id: "pat_01K3ABCDEFGHJKMNPQRSTVWXYZ",
      provider: "openrouter-free",
      providerKind: "openrouter",
      usageMode: "managed",
      model: "free-auto",
      outcome: "transient-error",
      responseStatus: 429,
      latencyMs: 800,
      retryCount: 0,
      fallback: false,
      timeCreated: 1_700_000_000_000,
    } as const
    const queued = message(providerAttempt)
    const consumer = createUsageQueueConsumer(
      async () => {
        throw new Error("usage persistence must not run")
      },
      undefined,
      () => providerAttempt.timeCreated,
      "dev",
      async (event) => void attempts.push(event),
    )

    await consumer.queue({ messages: [queued] })

    expect(queued.result()).toEqual({ acknowledged: 1, retried: 0 })
    expect(attempts).toEqual([providerAttempt])
  })
})
