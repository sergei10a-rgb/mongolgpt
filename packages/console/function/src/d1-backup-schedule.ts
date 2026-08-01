import { Resource } from "sst"

export type D1BackupWorkflowBinding = {
  create(input: {
    params: { scheduledTime: number }
    retention: { successRetention: string; errorRetention: string }
  }): Promise<{ id: string }>
}

export async function triggerScheduledD1Backup(scheduledTime: number, workflow: D1BackupWorkflowBinding) {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
    throw new TypeError("D1 backup scheduled time is invalid")
  }
  const instance = await workflow.create({
    params: { scheduledTime },
    retention: {
      successRetention: "30 days",
      errorRetention: "30 days",
    },
  })
  if (!instance.id) throw new Error("Cloudflare did not return a D1 backup workflow instance ID")
  return { instanceId: instance.id, scheduledTime }
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated SST types gain this binding after the first deploy
const resources = Resource as unknown as { D1BackupWorkflow: D1BackupWorkflowBinding }

export default {
  async scheduled(controller: { scheduledTime: number }) {
    const result = await triggerScheduledD1Backup(controller.scheduledTime, resources.D1BackupWorkflow)
    console.log("D1 backup workflow scheduled", result)
  },
}
