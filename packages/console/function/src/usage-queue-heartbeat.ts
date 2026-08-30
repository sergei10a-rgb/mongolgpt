import { Resource } from "@mongolgpt/console-resource"
import { createUsageQueueHeartbeat } from "@mongolgpt/console-core/usage-queue-readiness.js"

type QueueBinding = {
  send(message: ReturnType<typeof createUsageQueueHeartbeat>): Promise<unknown>
}

export function createUsageQueueHeartbeatSender(
  queue: QueueBinding,
  stage: string,
  now: () => number = Date.now,
  id: () => string = () => crypto.randomUUID(),
) {
  return async () => {
    const heartbeat = createUsageQueueHeartbeat(stage, now, id)
    await queue.send(heartbeat)
    return heartbeat
  }
}

export default {
  async scheduled() {
    const heartbeat = await createUsageQueueHeartbeatSender(Resource.UsageQueue, Resource.App.stage)()
    console.log("Хэрэглээний дарааллын хяналтын дохио илгээгдлээ", {
      stage: heartbeat.stage,
      heartbeatID: heartbeat.id,
      sentAt: heartbeat.sentAt,
    })
  },
}
