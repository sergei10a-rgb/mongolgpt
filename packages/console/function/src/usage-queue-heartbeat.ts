import { Resource } from "@mongolgpt/console-resource"
import { createUsageQueueHeartbeat } from "@mongolgpt/console-core/usage-queue-readiness.js"

type QueueBinding = {
  send(message: ReturnType<typeof createUsageQueueHeartbeat>): Promise<unknown>
}

export function createUsageQueueHeartbeatSender(
  queue: QueueBinding,
  now: () => number = Date.now,
  id: () => string = () => crypto.randomUUID(),
) {
  return async () => {
    const heartbeat = createUsageQueueHeartbeat(now, id)
    await queue.send(heartbeat)
    return heartbeat
  }
}

export default {
  async scheduled() {
    const heartbeat = await createUsageQueueHeartbeatSender(Resource.UsageQueue)()
    console.log("Хэрэглээний дарааллын хяналтын дохио илгээгдлээ", {
      heartbeatID: heartbeat.id,
      sentAt: heartbeat.sentAt,
    })
  },
}
