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

const businessSecrets = ["DISCORD_INCIDENT_WEBHOOK_URL", "AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY"] as const

export function businessIntegrationSecretNames(enabled: boolean) {
  return enabled ? businessSecrets : []
}
