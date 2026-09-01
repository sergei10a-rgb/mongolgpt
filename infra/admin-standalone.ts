import { createAdminDeployment } from "./admin-deployment"

const databaseId = required(
  "MONGOLGPT_ADMIN_DATABASE_ID",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
)
const d1BackupsBucket = required("MONGOLGPT_ADMIN_D1_BACKUPS_BUCKET", /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
const usageQueueReadinessId = required("MONGOLGPT_ADMIN_USAGE_QUEUE_READINESS_KV_ID", /^[0-9a-f]{32}$/i)
const serviceMonitorStateId = required("MONGOLGPT_ADMIN_SERVICE_MONITOR_STATE_KV_ID", /^[0-9a-f]{32}$/i)

const database = new sst.Linkable("Database", {
  properties: { databaseId },
  include: [sst.cloudflare.binding({ type: "d1DatabaseBindings", properties: { id: databaseId } })],
})
const d1Backups = new sst.Linkable("D1Backups", {
  properties: { name: d1BackupsBucket },
  include: [sst.cloudflare.binding({ type: "r2BucketBindings", properties: { bucketName: d1BackupsBucket } })],
})
const usageQueueReadiness = kv("UsageQueueReadiness", usageQueueReadinessId)
const serviceMonitorState = kv("ServiceMonitorState", serviceMonitorStateId)
const auth = service("AuthApi", "MONGOLGPT_ADMIN_AUTH_API_URL")
const quotaService = service("QuotaService", "MONGOLGPT_ADMIN_QUOTA_SERVICE_URL")
const paymentService = service("PaymentService", "MONGOLGPT_ADMIN_PAYMENT_SERVICE_URL")
const quotaServiceToken = importedSecretValue("QuotaServiceToken", "MONGOLGPT_ADMIN_QUOTA_SERVICE_TOKEN")
const paymentCancellationToken = importedSecretValue(
  "AdminPaymentCancellationToken",
  "MONGOLGPT_ADMIN_PAYMENT_CANCELLATION_TOKEN",
)
const paymentRefundToken = importedSecretValue("AdminPaymentRefundToken", "MONGOLGPT_ADMIN_PAYMENT_REFUND_TOKEN")
const mongolGPTPlanLimits = new sst.Secret("MONGOLGPT_PLAN_LIMITS")

const deployment = createAdminDeployment([
  database,
  d1Backups,
  auth,
  quotaService,
  paymentService,
  usageQueueReadiness,
  serviceMonitorState,
  quotaServiceToken,
  paymentCancellationToken,
  paymentRefundToken,
  mongolGPTPlanLimits,
])

export const admin = deployment.admin
export const adminUrl = deployment.adminUrl

function kv(name: string, namespaceId: string) {
  return new sst.Linkable(name, {
    properties: { namespaceId },
    include: [sst.cloudflare.binding({ type: "kvNamespaceBindings", properties: { namespaceId } })],
  })
}

function service(name: string, variable: string) {
  return new sst.Linkable(name, { properties: { url: serviceUrl(variable) } })
}

function importedSecretValue(name: string, variable: string) {
  return new sst.Linkable(name, { properties: { value: $util.secret(required(variable, /^.{32,}$/)) } })
}

function serviceUrl(variable: string) {
  const value = required(variable)
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error(`${variable} нь зөвхөн HTTPS origin байна.`)
  }
  return url.origin
}

function required(name: string, pattern?: RegExp) {
  const value = process.env[name]?.trim()
  if (!value || value.length > 2_048 || (pattern && !pattern.test(value))) {
    throw new Error(`${name} тохиргоо дутуу эсвэл буруу байна.`)
  }
  return value
}
