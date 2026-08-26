import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { Resource } from "sst"
import { scheduledBackupTime, startD1Export, storeCompletedD1Export, type BackupBucket } from "./d1-backup"

type Environment = {
  CLOUDFLARE_ACCOUNT_ID: string
  D1_DATABASE_ID: string
  MONGOLGPT_STAGE: string
}

type Parameters = {
  scheduledTime?: number
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated SST types gain these bindings after the first deploy
const resources = Resource as unknown as {
  D1BackupApiToken: { value: string }
  D1Backups: BackupBucket
}

export class D1BackupWorkflow extends WorkflowEntrypoint<Environment, Parameters> {
  async run(event: Readonly<WorkflowEvent<Parameters>>, step: WorkflowStep) {
    const scheduledTime = scheduledBackupTime(event.payload.scheduledTime, event.timestamp)
    const config = {
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      databaseId: this.env.D1_DATABASE_ID,
      apiToken: resources.D1BackupApiToken.value,
      stage: this.env.MONGOLGPT_STAGE,
    }
    const bookmark = await step.do(
      "Start D1 export",
      {
        retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      },
      () => startD1Export(config),
    )
    const receipt = await step.do(
      "Poll D1 export and store in R2",
      {
        retries: { limit: 60, delay: "30 seconds", backoff: "constant" },
        timeout: "5 minutes",
      },
      () => storeCompletedD1Export({ config, bookmark, scheduledTime, bucket: resources.D1Backups }),
    )
    console.log("D1 нөөц хуулбар хадгалагдлаа", receipt)
    return receipt
  }
}
