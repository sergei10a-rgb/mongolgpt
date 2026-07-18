export const quotaServiceMigrations = [
  {
    tag: "v1",
    newSqliteClasses: ["QuotaLedger"],
  },
] as const

const businessSecrets = ["DISCORD_INCIDENT_WEBHOOK_URL", "AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY"] as const

export function businessIntegrationSecretNames(enabled: boolean) {
  return enabled ? businessSecrets : []
}
