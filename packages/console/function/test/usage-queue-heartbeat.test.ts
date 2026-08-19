import { describe, expect, spyOn, test } from "bun:test"
import {
  createUsageQueueHeartbeat,
  USAGE_QUEUE_READINESS_KEY,
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
      () => 1_800_000_000_000,
      () => "heartbeat-test-id",
    )()
    expect(heartbeat).toEqual({
      type: "usage-queue-heartbeat",
      version: 1,
      id: "heartbeat-test-id",
      sentAt: 1_800_000_000_000,
    })
    expect(sent).toEqual([heartbeat])
    expect(UsageQueueHeartbeatSchema.safeParse(heartbeat).success).toBe(true)
  })

  test("stores bounded evidence and acknowledges only after KV succeeds", async () => {
    const writes: Array<[string, unknown, unknown?]> = []
    const heartbeat = createUsageQueueHeartbeat(
      () => 1_700_000_000_000,
      () => "id-1",
    )
    await recordUsageQueueHeartbeat({ put: async (...args) => void writes.push(args) }, heartbeat, 1_700_000_000_123)
    expect(writes).toEqual([
      [
        USAGE_QUEUE_READINESS_KEY,
        '{"version":1,"id":"id-1","sentAt":1700000000000,"processedAt":1700000000123}',
        { expirationTtl: 900 },
      ],
    ])

    await expect(
      recordUsageQueueHeartbeat({ put: async () => undefined }, heartbeat, heartbeat.sentAt - 1),
    ).rejects.toThrow("илгээхээс өмнө")
  })

  test("acks valid heartbeat, retries invalid and KV-failed messages, and preserves usage persistence", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    const heartbeat = createUsageQueueHeartbeat(
      () => 1_700_000_000_000,
      () => "id-2",
    )
    const valid = message(heartbeat)
    const invalid = message({ type: "usage-queue-heartbeat", version: 1, id: "bad", secret: "must-not-log" })
    const failed = message(heartbeat)
    const persisted: unknown[] = []
    const consumer = createUsageQueueConsumer(
      async (event) => void persisted.push(event),
      {
        put: async () => undefined,
      },
      () => 1_700_000_000_100,
    )
    await consumer.queue({ messages: [valid, invalid] })

    const failedConsumer = createUsageQueueConsumer(
      async (event) => void persisted.push(event),
      {
        put: async () => {
          throw new Error("KV unavailable")
        },
      },
      () => 1_700_000_000_100,
    )
    await failedConsumer.queue({ messages: [failed] })
    expect(valid.result()).toEqual({ acknowledged: 1, retried: 0 })
    expect(invalid.result()).toEqual({ acknowledged: 0, retried: 1 })
    expect(failed.result()).toEqual({ acknowledged: 0, retried: 1 })
    expect(persisted).toEqual([])
    expect(error.mock.calls).toHaveLength(2)
    expect(JSON.stringify(error.mock.calls)).not.toContain("KV unavailable")
    expect(JSON.stringify(error.mock.calls)).not.toContain("must-not-log")
    error.mockRestore()
  })
})
