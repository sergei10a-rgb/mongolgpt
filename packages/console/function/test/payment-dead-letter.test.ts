import { describe, expect, spyOn, test } from "bun:test"
import { createPaymentDeadLetterConsumer } from "../src/payment-dead-letter"

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

describe("payment dead-letter consumer", () => {
  test("acknowledges only after durable recovery persistence", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    const received: unknown[] = []
    const queued = message({ version: 1 })
    const consumer = createPaymentDeadLetterConsumer(
      async (input) => {
        received.push(input)
        return { id: "prc_test", status: "pending", validEvent: true, changed: true }
      },
      () => 123,
    )

    await consumer.queue({ messages: [queued] })

    expect(received).toEqual([{ body: { version: 1 }, now: 123 }])
    expect(queued.result()).toEqual({ acknowledged: 1, retried: 0 })
    warning.mockRestore()
  })

  test("retries without logging the dead-letter body when persistence fails", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    const secret = "do-not-log-this"
    const queued = message({ secret })
    const consumer = createPaymentDeadLetterConsumer(
      async () => {
        throw new Error(secret)
      },
      Date.now,
      async () => {
        throw new Error(secret)
      },
    )

    await consumer.queue({ messages: [queued] })

    expect(queued.result()).toEqual({ acknowledged: 0, retried: 1 })
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret)
    error.mockRestore()
  })

  test("acknowledges only after the R2 archive succeeds when D1 is unavailable", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    const secret = "do-not-log-this"
    const queued = message({ secret })
    const archived: unknown[] = []
    const consumer = createPaymentDeadLetterConsumer(
      async () => {
        throw new Error(secret)
      },
      () => 789,
      async (input) => {
        archived.push(input)
        return { key: "payment-recovery/v1/test.json", messageHash: "a".repeat(64) }
      },
    )

    await consumer.queue({ messages: [queued] })

    expect(archived).toEqual([{ body: { secret }, now: 789 }])
    expect(queued.result()).toEqual({ acknowledged: 1, retried: 0 })
    expect(JSON.stringify(warning.mock.calls)).not.toContain(secret)
    warning.mockRestore()
  })
})
