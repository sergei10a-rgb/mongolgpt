import {
  appOrigin,
  docsOrigin,
  domain,
  enableBusinessIntegrations,
  enableD1Backups,
  enableMonitoring,
  enableShareService,
  enableTurnstile,
  paymentOrigin,
  publicOrigin,
  runtimeOrigin,
  shareOrigin,
} from "./stage"
import { database } from "./database"
import {
  businessIntegrationSecretNames,
  D1_BACKUP_MULTIPART_ABORT_SECONDS,
  D1_BACKUP_RETENTION_SECONDS,
  D1_BACKUP_SCHEDULE,
  quotaServiceMigrations,
} from "./console-policy"
import { SECRET } from "./secret"

////////////////
// DATABASE
////////////////

export { database } from "./database"

new sst.x.DevCommand("Studio", {
  link: [database],
  dev: {
    command: "bun run db-studio",
    directory: "packages/console/core",
    autostart: true,
  },
})

export const d1Backups = new sst.cloudflare.Bucket("D1Backups")

new cloudflare.R2BucketLifecycle(
  "D1BackupRetention",
  {
    accountId: sst.cloudflare.DEFAULT_ACCOUNT_ID,
    bucketName: d1Backups.name,
    rules: [
      {
        id: "expire-d1-backups-after-90-days",
        conditions: { prefix: "d1/" },
        enabled: true,
        deleteObjectsTransition: {
          condition: { maxAge: D1_BACKUP_RETENTION_SECONDS, type: "Age" },
        },
        abortMultipartUploadsTransition: {
          condition: { maxAge: D1_BACKUP_MULTIPART_ABORT_SECONDS, type: "Age" },
        },
      },
    ],
  },
  { dependsOn: [d1Backups.nodes.bucket] },
)

const d1BackupAutomation = enableD1Backups
  ? (() => {
      const workflow = new sst.cloudflare.Workflow("D1BackupWorkflow", {
        handler: "packages/console/function/src/d1-backup-workflow.ts",
        className: "D1BackupWorkflow",
        link: [d1Backups, SECRET.D1BackupApiToken],
        environment: {
          CLOUDFLARE_ACCOUNT_ID: sst.cloudflare.DEFAULT_ACCOUNT_ID,
          D1_DATABASE_ID: database.databaseId,
          MONGOLGPT_STAGE: $app.stage,
        },
      })
      const schedule = new sst.cloudflare.Cron("D1BackupSchedule", {
        schedules: [D1_BACKUP_SCHEDULE],
        worker: {
          handler: "packages/console/function/src/d1-backup-schedule.ts",
          link: [workflow],
          compatibility: {
            date: "2026-07-15",
          },
        },
      })
      return { schedule, workflow }
    })()
  : undefined

export const d1BackupWorkflow = d1BackupAutomation?.workflow
export const d1BackupSchedule = d1BackupAutomation?.schedule

////////////////
// QUOTA AND USAGE
////////////////

const usageDeadLetterQueue = new sst.cloudflare.Queue("UsageDeadLetterQueue")
export const usageQueue = new sst.cloudflare.Queue("UsageQueue", {
  dlq: {
    queue: usageDeadLetterQueue.nodes.queue.queueName,
    retry: 5,
    retryDelay: "30 seconds",
  },
})
export const usageQueueReadiness = new sst.cloudflare.Kv("UsageQueueReadiness")
export const serviceMonitorState = new sst.cloudflare.Kv("ServiceMonitorState")

usageQueue.subscribe(
  {
    handler: "packages/console/function/src/usage-queue.ts",
    link: [database, usageQueueReadiness],
  },
  {
    batch: {
      size: 10,
      window: "5 seconds",
    },
  },
)

export const usageQueueHeartbeat = new sst.cloudflare.Cron("UsageQueueHeartbeat", {
  schedules: ["*/5 * * * *"],
  worker: {
    handler: "packages/console/function/src/usage-queue-heartbeat.ts",
    link: [usageQueue],
    compatibility: {
      date: "2026-07-15",
    },
  },
})

const paymentDeadLetterQueue = new sst.cloudflare.Queue("PaymentDeadLetterQueue")
export const paymentQueue = new sst.cloudflare.Queue("PaymentQueue", {
  dlq: {
    queue: paymentDeadLetterQueue.nodes.queue.queueName,
    retry: 8,
    retryDelay: "30 seconds",
  },
})

const paymentEnvironment = process.env.MONGOLGPT_PAYMENT_ENVIRONMENT?.trim() || "disabled"
if (!["disabled", "sandbox", "production"].includes(paymentEnvironment)) {
  throw new Error("MONGOLGPT_PAYMENT_ENVIRONMENT must be disabled, sandbox, or production.")
}
if (paymentEnvironment === "production" && process.env.MONGOLGPT_ENABLE_REAL_PAYMENTS !== "true") {
  throw new Error("Production payments require MONGOLGPT_ENABLE_REAL_PAYMENTS=true.")
}

const paymentConfig = new sst.Linkable("PaymentConfig", {
  properties: {
    enabled: paymentEnvironment !== "disabled",
    environment: paymentEnvironment === "production" ? "production" : "sandbox",
    realPaymentsEnabled: process.env.MONGOLGPT_ENABLE_REAL_PAYMENTS === "true",
    realPaymentConfirmation:
      paymentEnvironment === "production" &&
      process.env.MONGOLGPT_REAL_PAYMENT_CONFIRMATION === `ENABLE REAL PAYMENTS ${domain}`,
    callbackBaseURL: paymentOrigin,
    bonumProviders: ["E_COMMERCE"],
    planCatalog: process.env.MONGOLGPT_PAYMENT_PLAN_CATALOG?.trim() || "",
  },
})
const QPAY_MERCHANT_ACCOUNT_ID = new sst.Secret("QPayMerchantAccountID", "disabled")
const QPAY_CLIENT_ID = new sst.Secret("QPayClientID", "disabled")
const QPAY_CLIENT_SECRET = new sst.Secret("QPayClientSecret", "disabled")
const QPAY_INVOICE_CODE = new sst.Secret("QPayInvoiceCode", "disabled")
const BONUM_MERCHANT_ACCOUNT_ID = new sst.Secret("BonumMerchantAccountID", "disabled")
const BONUM_APP_SECRET = new sst.Secret("BonumAppSecret", "disabled")
const BONUM_TERMINAL_ID = new sst.Secret("BonumTerminalID", "disabled")
const BONUM_WEBHOOK_CHECKSUM_KEY = new sst.Secret("BonumWebhookChecksumKey", "disabled")

export const paymentService = new sst.cloudflare.Worker("PaymentService", {
  domain: `pay.${domain}`,
  handler: "packages/console/function/src/payment-webhook.ts",
  url: true,
  link: [
    database,
    paymentQueue,
    paymentConfig,
    QPAY_MERCHANT_ACCOUNT_ID,
    QPAY_CLIENT_ID,
    QPAY_CLIENT_SECRET,
    QPAY_INVOICE_CODE,
    BONUM_MERCHANT_ACCOUNT_ID,
    BONUM_APP_SECRET,
    BONUM_TERMINAL_ID,
    BONUM_WEBHOOK_CHECKSUM_KEY,
    SECRET.PaymentServiceToken,
    SECRET.AdminPaymentCancellationToken,
    SECRET.AdminPaymentRefundToken,
  ],
  compatibility: {
    date: "2026-07-15",
  },
})

export const quotaService = new sst.cloudflare.Worker("QuotaService", {
  handler: "packages/console/function/src/quota.ts",
  url: true,
  link: [usageQueue, SECRET.QuotaServiceToken],
  compatibility: {
    date: "2026-07-15",
  },
  migrations: quotaServiceMigrations,
  transform: {
    worker: (args) => {
      args.bindings = $resolve(args.bindings).apply((bindings) => [
        ...bindings,
        {
          name: "QUOTA_LEDGER",
          type: "durable_object_namespace",
          className: "QuotaLedger",
        },
      ])
    },
  },
})

paymentQueue.subscribe(
  {
    handler: "packages/console/function/src/payment-queue.ts",
    link: [database, quotaService, SECRET.QuotaServiceToken],
  },
  {
    batch: {
      size: 10,
      window: "5 seconds",
    },
  },
)

paymentDeadLetterQueue.subscribe(
  {
    handler: "packages/console/function/src/payment-dead-letter.ts",
    link: [database],
  },
  {
    batch: {
      size: 10,
      window: "5 seconds",
    },
  },
)

export const paymentRecovery = new sst.cloudflare.Cron("PaymentRecovery", {
  schedules: ["*/5 * * * *"],
  worker: {
    handler: "packages/console/function/src/payment-recovery.ts",
    link: [database, quotaService, SECRET.QuotaServiceToken],
    compatibility: {
      date: "2026-07-15",
    },
  },
})

export const subscriptionExpiration = new sst.cloudflare.Cron("SubscriptionExpiration", {
  schedules: ["*/5 * * * *"],
  worker: {
    handler: "packages/console/function/src/subscription-expiration.ts",
    link: [database],
    compatibility: {
      date: "2026-07-15",
    },
  },
})

export const accountDeletionRetention = new sst.cloudflare.Cron("AccountDeletionRetention", {
  schedules: ["*/15 * * * *"],
  worker: {
    handler: "packages/console/function/src/account-deletion.ts",
    link: [database],
    compatibility: {
      date: "2026-07-15",
    },
  },
})

////////////////
// AUTH
////////////////

const GITHUB_CLIENT_ID_CONSOLE = new sst.Secret("GITHUB_CLIENT_ID_CONSOLE", "")
const GITHUB_CLIENT_SECRET_CONSOLE = new sst.Secret("GITHUB_CLIENT_SECRET_CONSOLE", "")
const GOOGLE_CLIENT_ID = new sst.Secret("GOOGLE_CLIENT_ID", "")
const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA"
const TURNSTILE_TEST_SECRET_KEY = "1x0000000000000000000000000000000AA"
const turnstileSiteKey =
  process.env.MONGOLGPT_TURNSTILE_SITE_KEY?.trim() || ($app.stage === "production" ? "" : TURNSTILE_TEST_SITE_KEY)
if (enableTurnstile && !turnstileSiteKey) {
  throw new Error("Turnstile идэвхтэй үед MONGOLGPT_TURNSTILE_SITE_KEY заавал байна.")
}
if ($app.stage === "production" && /^[123]x0{10,}/.test(turnstileSiteKey)) {
  throw new Error("Production орчинд Cloudflare Turnstile-ийн test site key ашиглахгүй.")
}
const TURNSTILE_SECRET_KEY =
  $app.stage === "production"
    ? new sst.Secret("TurnstileSecretKey")
    : new sst.Secret("TurnstileSecretKey", TURNSTILE_TEST_SECRET_KEY)
const devCloudflareSecrets = $dev
  ? [
      new sst.Secret("CLOUDFLARE_DEFAULT_ACCOUNT_ID", process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID),
      new sst.Secret("CLOUDFLARE_API_TOKEN", process.env.CLOUDFLARE_API_TOKEN),
    ]
  : []
const authStorage = new sst.cloudflare.Kv("AuthStorage")
export const auth = new sst.cloudflare.Worker("AuthApi", {
  domain: `auth.${domain}`,
  handler: "packages/console/function/src/auth.ts",
  url: true,
  environment: {
    MONGOLGPT_AUTH_EMAIL_DOMAINS: process.env.MONGOLGPT_AUTH_EMAIL_DOMAINS ?? "",
    MONGOLGPT_CONSOLE_ORIGIN: publicOrigin,
    MONGOLGPT_TURNSTILE_ENABLED: enableTurnstile ? "true" : "false",
  },
  link: [
    database,
    authStorage,
    GITHUB_CLIENT_ID_CONSOLE,
    GITHUB_CLIENT_SECRET_CONSOLE,
    GOOGLE_CLIENT_ID,
    TURNSTILE_SECRET_KEY,
    ...devCloudflareSecrets,
  ],
})

////////////////
// GATEWAY
////////////////

const disabledBillingValue = "disabled"
const MONGOLGPT_PLAN_PRICE = new sst.Linkable("MONGOLGPT_PLAN_PRICE", {
  properties: {
    product: disabledBillingValue,
    basic: disabledBillingValue,
    pro: disabledBillingValue,
    max: disabledBillingValue,
  },
})

const MONGOLGPT_GATEWAY_MODELS = [
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS1", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS2", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS3", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS4", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS5", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS6", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS7", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS8", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS9", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS10", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS11", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS12", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS13", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS14", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS15", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS16", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS17", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS18", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS19", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS20", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS21", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS22", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS23", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS24", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS25", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS26", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS27", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS28", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS29", ""),
  new sst.Secret("MONGOLGPT_GATEWAY_MODELS30", ""),
]
const AUTH_API_URL = new sst.Linkable("AUTH_API_URL", {
  properties: { value: auth.url.apply((url) => url!) },
})

////////////////
// CONSOLE
////////////////

const bucket = new sst.cloudflare.Bucket("ZenData")
const bucketNew = new sst.cloudflare.Bucket("ZenDataNew")

const businessIntegrationSecrets = businessIntegrationSecretNames(enableBusinessIntegrations).map(
  (name) => new sst.Secret(name),
)
export const mongolGPTPlanLimits = new sst.Secret("MONGOLGPT_PLAN_LIMITS")

export const consoleApp = new sst.cloudflare.x.SolidStart("Console", {
  domain,
  path: "packages/console/app",
  link: [
    bucket,
    bucketNew,
    database,
    quotaService,
    paymentService,
    paymentConfig,
    SECRET.QuotaServiceToken,
    SECRET.PaymentServiceToken,
    SECRET.MongolGPTRuntimeAuthSecret,
    SECRET.ByokCredentialsKeyV1,
    AUTH_API_URL,
    SECRET.SupportApiKey,
    MONGOLGPT_PLAN_PRICE,
    mongolGPTPlanLimits,
    new sst.Secret("MONGOLGPT_GATEWAY_SESSION_SECRET", ""),
    ...MONGOLGPT_GATEWAY_MODELS,
    ...businessIntegrationSecrets,
    ...devCloudflareSecrets,
  ],
  environment: {
    VITE_AUTH_URL: auth.url.apply((url) => url!),
    MONGOLGPT_APP_URL: appOrigin,
    MONGOLGPT_RUNTIME_URL: runtimeOrigin,
    VITE_MONGOLGPT_BILLING_ENABLED: "false",
    MONGOLGPT_BILLING_PROVIDER: "disabled",
    VITE_MONGOLGPT_PUBLIC_URL: publicOrigin,
    VITE_MONGOLGPT_DOCS_URL: docsOrigin,
    VITE_MONGOLGPT_ENTERPRISE_URL: enableShareService ? shareOrigin : "",
    VITE_MONGOLGPT_COMMUNITY_URL: "https://github.com/sergei10a-rgb/mongolgpt/discussions",
    MONGOLGPT_CONSOLE_URL: publicOrigin,
    MONGOLGPT_FREE_WORKSPACE_IDS: process.env.MONGOLGPT_FREE_WORKSPACE_IDS ?? "",
    MONGOLGPT_TURNSTILE_ENABLED: enableTurnstile ? "true" : "false",
    MONGOLGPT_TURNSTILE_SITE_KEY: turnstileSiteKey,
  },
})

export const serviceMonitor = enableMonitoring
  ? new sst.cloudflare.Cron("ServiceMonitor", {
      schedules: ["*/5 * * * *"],
      worker: {
        handler: "packages/console/function/src/service-monitor.ts",
        link: [serviceMonitorState],
        environment: {
          MONGOLGPT_STAGE: $app.stage,
          MONGOLGPT_STAGE_DOMAIN: domain,
        },
        compatibility: {
          date: "2026-07-15",
        },
      },
    })
  : undefined

////////////////
// HELPERS
////////////////

export const stat = new sst.cloudflare.Worker("Stat", {
  handler: "packages/console/function/src/stat.ts",
  link: [database],
  url: true,
})
