import {
  appOrigin,
  docsOrigin,
  domain,
  enableBusinessIntegrations,
  enableMonitoring,
  enableShareService,
  publicOrigin,
  shareOrigin,
} from "./stage"
import { businessIntegrationSecretNames, quotaServiceMigrations } from "./console-policy"
import { SECRET } from "./secret"

////////////////
// DATABASE
////////////////

export const database = new sst.cloudflare.D1("Database")

new sst.x.DevCommand("Studio", {
  link: [database],
  dev: {
    command: "bun run db-studio",
    directory: "packages/console/core",
    autostart: true,
  },
})

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

usageQueue.subscribe(
  {
    handler: "packages/console/function/src/usage-queue.ts",
    link: [database],
  },
  {
    batch: {
      size: 10,
      window: "5 seconds",
    },
  },
)

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
    callbackBaseURL: `https://pay.${domain}`,
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

////////////////
// AUTH
////////////////

const GITHUB_CLIENT_ID_CONSOLE = new sst.Secret("GITHUB_CLIENT_ID_CONSOLE")
const GITHUB_CLIENT_SECRET_CONSOLE = new sst.Secret("GITHUB_CLIENT_SECRET_CONSOLE")
const GOOGLE_CLIENT_ID = new sst.Secret("GOOGLE_CLIENT_ID")
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
  },
  link: [
    database,
    authStorage,
    GITHUB_CLIENT_ID_CONSOLE,
    GITHUB_CLIENT_SECRET_CONSOLE,
    GOOGLE_CLIENT_ID,
    ...devCloudflareSecrets,
  ],
})

////////////////
// GATEWAY
////////////////

const disabledBillingValue = "disabled"
const ZEN_LITE_PRICE = new sst.Linkable("ZEN_LITE_PRICE", {
  properties: {
    product: disabledBillingValue,
    price: disabledBillingValue,
    priceInr: 0,
    firstMonth50Coupon: disabledBillingValue,
    firstMonth100Coupon: disabledBillingValue,
    threeMonths100Coupon: disabledBillingValue,
    sixMonths100Coupon: disabledBillingValue,
    twelveMonths100Coupon: disabledBillingValue,
  },
})
const MONGOLGPT_PLAN_PRICE = new sst.Linkable("MONGOLGPT_PLAN_PRICE", {
  properties: {
    product: disabledBillingValue,
    basic: disabledBillingValue,
    pro: disabledBillingValue,
    max: disabledBillingValue,
  },
})

const ZEN_MODELS = [
  new sst.Secret("ZEN_MODELS1"),
  new sst.Secret("ZEN_MODELS2", ""),
  new sst.Secret("ZEN_MODELS3", ""),
  new sst.Secret("ZEN_MODELS4", ""),
  new sst.Secret("ZEN_MODELS5", ""),
  new sst.Secret("ZEN_MODELS6", ""),
  new sst.Secret("ZEN_MODELS7", ""),
  new sst.Secret("ZEN_MODELS8", ""),
  new sst.Secret("ZEN_MODELS9", ""),
  new sst.Secret("ZEN_MODELS10", ""),
  new sst.Secret("ZEN_MODELS11", ""),
  new sst.Secret("ZEN_MODELS12", ""),
  new sst.Secret("ZEN_MODELS13", ""),
  new sst.Secret("ZEN_MODELS14", ""),
  new sst.Secret("ZEN_MODELS15", ""),
  new sst.Secret("ZEN_MODELS16", ""),
  new sst.Secret("ZEN_MODELS17", ""),
  new sst.Secret("ZEN_MODELS18", ""),
  new sst.Secret("ZEN_MODELS19", ""),
  new sst.Secret("ZEN_MODELS20", ""),
  new sst.Secret("ZEN_MODELS21", ""),
  new sst.Secret("ZEN_MODELS22", ""),
  new sst.Secret("ZEN_MODELS23", ""),
  new sst.Secret("ZEN_MODELS24", ""),
  new sst.Secret("ZEN_MODELS25", ""),
  new sst.Secret("ZEN_MODELS26", ""),
  new sst.Secret("ZEN_MODELS27", ""),
  new sst.Secret("ZEN_MODELS28", ""),
  new sst.Secret("ZEN_MODELS29", ""),
  new sst.Secret("ZEN_MODELS30", ""),
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

const logProcessor = enableMonitoring
  ? new sst.cloudflare.Worker("LogProcessor", {
      handler: "packages/console/function/src/log-processor.ts",
      link: [SECRET.HoneycombApiKey],
    })
  : undefined

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
    SECRET.ByokCredentialsKeyV1,
    AUTH_API_URL,
    SECRET.SupportApiKey,
    SECRET.HoneycombWebhookSecret,
    MONGOLGPT_PLAN_PRICE,
    ZEN_LITE_PRICE,
    new sst.Secret("MONGOLGPT_PLAN_LIMITS"),
    new sst.Secret("ZEN_SESSION_SECRET"),
    ...ZEN_MODELS,
    ...businessIntegrationSecrets,
    ...devCloudflareSecrets,
  ],
  environment: {
    VITE_AUTH_URL: auth.url.apply((url) => url!),
    MONGOLGPT_APP_URL: appOrigin,
    MONGOLGPT_COOKIE_DOMAIN: process.env.MONGOLGPT_COOKIE_DOMAIN?.trim() || ($dev ? "" : `.${domain}`),
    VITE_MONGOLGPT_BILLING_ENABLED: "false",
    MONGOLGPT_BILLING_PROVIDER: "disabled",
    VITE_MONGOLGPT_PUBLIC_URL: publicOrigin,
    VITE_MONGOLGPT_DOCS_URL: docsOrigin,
    VITE_MONGOLGPT_ENTERPRISE_URL: enableShareService ? shareOrigin : "",
    VITE_MONGOLGPT_COMMUNITY_URL: "https://github.com/sergei10a-rgb/mongolgpt/discussions",
    MONGOLGPT_CONSOLE_URL: publicOrigin,
    MONGOLGPT_FREE_WORKSPACE_IDS: process.env.MONGOLGPT_FREE_WORKSPACE_IDS ?? "",
  },
  transform: {
    server: logProcessor
      ? {
          transform: {
            worker: {
              tailConsumers: [{ service: logProcessor.nodes.worker.scriptName }],
            },
          },
        }
      : {},
  },
})

////////////////
// HELPERS
////////////////

export const stat = new sst.cloudflare.Worker("Stat", {
  handler: "packages/console/function/src/stat.ts",
  link: [database],
  url: true,
})
