export const quotaServiceMigrations = [
  {
    tag: "v1",
    newSqliteClasses: ["QuotaLedger"],
  },
] as const

export const D1_BACKUP_SCHEDULE = "20 0 * * *"
export const D1_BACKUP_RETENTION_DAYS = 90
export const D1_BACKUP_RETENTION_SECONDS = D1_BACKUP_RETENTION_DAYS * 24 * 60 * 60
export const D1_BACKUP_MULTIPART_ABORT_SECONDS = 24 * 60 * 60

export const PAYMENT_QUEUE_RETENTION_DAYS = 14
export const PAYMENT_QUEUE_RETENTION_SECONDS = PAYMENT_QUEUE_RETENTION_DAYS * 24 * 60 * 60
export const PAYMENT_DEAD_LETTER_RETRIES = 100

const businessSecrets = ["AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY"] as const

export function businessIntegrationSecretNames(enabled: boolean) {
  return enabled ? businessSecrets : []
}

export function runtimeAccountCleanupBinding(stage: string, enabled: boolean) {
  if (!enabled) return undefined
  if (stage !== "dev" && stage !== "production")
    throw new Error("Runtime устгалд dev эсвэл production орчныг тодорхой заана")
  return { service: `mongolgpt-runtime-${stage}`, entrypoint: "RuntimeAccountCleanup" }
}
