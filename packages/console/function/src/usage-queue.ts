import { UsageQueueEventSchema, type UsageQueueEvent } from "@mongolgpt/console-core/quota.js"
import { persistUsageQueueEvent } from "@mongolgpt/console-core/usage-queue.js"

export default {
  async queue(batch: MessageBatch<UsageQueueEvent>) {
    for (const message of batch.messages) {
      try {
        const event = UsageQueueEventSchema.parse(message.body)
        await persistUsageQueueEvent(event)
        message.ack()
      } catch (error) {
        console.error("Usage queue event failed", {
          eventID:
            message.body && typeof message.body === "object" && "id" in message.body ? message.body.id : "unknown",
          error,
        })
        message.retry()
      }
    }
  },
}
