import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { currency, id, timestamps, ulid, utc, workspaceColumns } from "../drizzle-d1/types"

export const AuthProvider = ["email", "github", "google"] as const
export const UserRole = ["admin", "member"] as const
export const PlanNames = ["basic", "pro", "max"] as const
export const PaymentProviders = ["qpay", "bonum"] as const
export const PaymentPurposes = ["subscription", "credit"] as const
export const PaymentInvoiceStatuses = [
  "created",
  "pending",
  "paid",
  "failed",
  "expired",
  "cancelled",
  "refunded",
] as const
export const PaymentCheckoutStatuses = [
  "creating",
  "unknown",
  "ready",
  "pending",
  "paid",
  "failed",
  "expired",
  "cancelled",
  "refunded",
] as const
export const PaymentCancellationStatuses = ["requested", "unknown", "cancelled", "failed"] as const
export const PaymentEventTypes = ["pending", "paid", "failed", "expired", "cancelled", "refunded"] as const
export const PaymentEventOutcomes = ["applied", "noop", "rejected"] as const
export const PlanSubscriptionStatuses = ["active", "expired", "cancelled", "refunded"] as const
export const NewsletterSubscriberStatus = ["active", "unsubscribed"] as const
export const NewsletterSubscriberSource = ["console", "stats"] as const
export const EnterpriseInquiryStatus = ["new", "reviewing", "resolved", "spam"] as const
export const EnterpriseInquirySource = ["enterprise"] as const
export const LegacyPlanCodes = ["20", "100", "200"] as const
/** @deprecated Legacy maintenance scripts only. */
export const BlackPlans = LegacyPlanCodes
export const CouponType = [
  "BUILDATHON",
  "GO1MONTH50",
  "GOFREEMONTH",
  "GO3MONTHS100",
  "GO6MONTHS100",
  "GO12MONTHS100",
] as const

const workspaceIndexes = (table: { workspaceID: AnySQLiteColumn; id: AnySQLiteColumn }) => [
  primaryKey({ columns: [table.workspaceID, table.id] }),
]

export const AccountTable = sqliteTable(
  "account",
  {
    id: id(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.id] })],
)

export const AuthTable = sqliteTable(
  "auth",
  {
    id: id(),
    ...timestamps,
    provider: text("provider", { enum: AuthProvider }).notNull(),
    subject: text("subject", { length: 255 }).notNull(),
    accountID: ulid("account_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("auth_provider_subject").on(table.provider, table.subject),
    index("auth_account_id").on(table.accountID),
    check("auth_provider_check", sql`${table.provider} in ('email', 'github', 'google')`),
  ],
)

export const BenchmarkTable = sqliteTable(
  "benchmark",
  {
    id: id(),
    ...timestamps,
    model: text("model", { length: 64 }).notNull(),
    agent: text("agent", { length: 64 }).notNull(),
    result: text("result").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] }), index("benchmark_time_created").on(table.timeCreated)],
)

export const NewsletterSubscriberTable = sqliteTable(
  "newsletter_subscriber",
  {
    email: text("email", { length: 254 }).notNull(),
    locale: text("locale", { length: 16 }).notNull().default("mn"),
    source: text("source", { enum: NewsletterSubscriberSource }).notNull().default("stats"),
    status: text("status", { enum: NewsletterSubscriberStatus }).notNull().default("active"),
    consentVersion: text("consent_version", { length: 32 }).notNull(),
    timeConsented: utc("time_consented").notNull(),
    ...timestamps,
    timeUnsubscribed: utc("time_unsubscribed"),
  },
  (table) => [
    primaryKey({ columns: [table.email] }),
    index("newsletter_subscriber_status_time_created").on(table.status, table.timeCreated),
    check("newsletter_subscriber_source_check", sql`${table.source} in ('console', 'stats')`),
    check("newsletter_subscriber_status_check", sql`${table.status} in ('active', 'unsubscribed')`),
  ],
)

export const EnterpriseInquiryTable = sqliteTable(
  "enterprise_inquiry",
  {
    id: id(),
    name: text("name", { length: 120 }).notNull(),
    role: text("role", { length: 120 }).notNull(),
    company: text("company", { length: 200 }),
    email: text("email", { length: 254 }).notNull(),
    phone: text("phone", { length: 64 }),
    message: text("message", { length: 5_000 }).notNull(),
    locale: text("locale", { length: 16 }).notNull().default("mn"),
    source: text("source", { enum: EnterpriseInquirySource }).notNull().default("enterprise"),
    status: text("status", { enum: EnterpriseInquiryStatus }).notNull().default("new"),
    formVersion: text("form_version", { length: 32 }).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("enterprise_inquiry_status_time_created").on(table.status, table.timeCreated),
    index("enterprise_inquiry_email").on(table.email),
    check("enterprise_inquiry_source_check", sql`${table.source} in ('enterprise')`),
    check("enterprise_inquiry_status_check", sql`${table.status} in ('new', 'reviewing', 'resolved', 'spam')`),
  ],
)

export const WorkspaceTable = sqliteTable(
  "workspace",
  {
    id: ulid("id").notNull(),
    slug: text("slug", { length: 255 }),
    name: text("name", { length: 255 }).notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.id] }), uniqueIndex("workspace_slug").on(table.slug)],
)

export const UserTable = sqliteTable(
  "user",
  {
    ...workspaceColumns,
    ...timestamps,
    accountID: ulid("account_id"),
    email: text("email", { length: 255 }),
    name: text("name", { length: 255 }).notNull(),
    timeSeen: utc("time_seen"),
    color: integer("color"),
    role: text("role", { enum: UserRole }).notNull(),
    monthlyLimit: integer("monthly_limit"),
    monthlyUsage: integer("monthly_usage"),
    timeMonthlyUsageUpdated: utc("time_monthly_usage_updated"),
  },
  (table) => [
    ...workspaceIndexes(table),
    uniqueIndex("user_workspace_account_id").on(table.workspaceID, table.accountID),
    uniqueIndex("user_workspace_email").on(table.workspaceID, table.email),
    index("user_global_account_id").on(table.accountID),
    index("user_global_email").on(table.email),
    check("user_role_check", sql`${table.role} in ('admin', 'member')`),
  ],
)

export const BillingTable = sqliteTable(
  "billing",
  {
    ...workspaceColumns,
    ...timestamps,
    customerID: text("customer_id", { length: 255 }),
    paymentMethodID: text("payment_method_id", { length: 255 }),
    paymentMethodType: text("payment_method_type", { length: 32 }),
    paymentMethodLast4: text("payment_method_last4", { length: 4 }),
    balance: currency("balance").notNull(),
    monthlyLimit: integer("monthly_limit"),
    monthlyUsage: integer("monthly_usage"),
    timeMonthlyUsageUpdated: utc("time_monthly_usage_updated"),
    reload: integer("reload", { mode: "boolean" }),
    reloadTrigger: integer("reload_trigger"),
    reloadAmount: integer("reload_amount"),
    reloadError: text("reload_error", { length: 255 }),
    timeReloadError: utc("time_reload_error"),
    timeReloadLockedTill: utc("time_reload_locked_till"),
    subscription: text("subscription", { mode: "json" }).$type<{
      status: "subscribed"
      seats: number
      plan: (typeof PlanNames)[number]
      useBalance?: boolean
      coupon?: string
      source?: "stripe" | (typeof PaymentProviders)[number]
      invoiceID?: string
      currentPeriodStart?: number
      currentPeriodEnd?: number
    }>(),
    subscriptionID: text("subscription_id", { length: 28 }),
    subscriptionPlan: text("subscription_plan", { enum: PlanNames }),
    timeSubscriptionBooked: utc("time_subscription_booked"),
    timeSubscriptionSelected: utc("time_subscription_selected"),
    liteSubscriptionID: text("lite_subscription_id", { length: 28 }),
    lite: text("lite", { mode: "json" }).$type<{ useBalance?: boolean }>(),
  },
  (table) => [
    ...workspaceIndexes(table),
    uniqueIndex("billing_global_customer_id").on(table.customerID),
    uniqueIndex("billing_global_subscription_id").on(table.subscriptionID),
    check(
      "billing_subscription_plan_check",
      sql`${table.subscriptionPlan} is null or ${table.subscriptionPlan} in ('basic', 'pro', 'max')`,
    ),
    check("billing_subscription_json_check", sql`${table.subscription} is null or json_valid(${table.subscription})`),
    check("billing_lite_json_check", sql`${table.lite} is null or json_valid(${table.lite})`),
  ],
)

export const SubscriptionTable = sqliteTable(
  "subscription",
  {
    ...workspaceColumns,
    ...timestamps,
    userID: ulid("user_id").notNull(),
    rollingUsage: integer("rolling_usage"),
    fixedUsage: integer("fixed_usage"),
    weeklyTokens: integer("weekly_tokens"),
    timeRollingUpdated: utc("time_rolling_updated"),
    timeFixedUpdated: utc("time_fixed_updated"),
    timeWeeklyTokensUpdated: utc("time_weekly_tokens_updated"),
  },
  (table) => [
    ...workspaceIndexes(table),
    uniqueIndex("subscription_workspace_user_id").on(table.workspaceID, table.userID),
  ],
)

export const PlanSubscriptionTable = sqliteTable(
  "plan_subscription",
  {
    id: id(),
    workspaceID: ulid("workspace_id").notNull(),
    invoiceID: ulid("invoice_id").notNull(),
    plan: text("plan", { enum: PlanNames }).notNull(),
    status: text("status", { enum: PlanSubscriptionStatuses }).notNull().default("active"),
    timePeriodStart: utc("time_period_start").notNull(),
    timePeriodEnd: utc("time_period_end").notNull(),
    timeCancelled: utc("time_cancelled"),
    timeRefunded: utc("time_refunded"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("plan_subscription_invoice_id").on(table.invoiceID),
    index("plan_subscription_workspace_period_end").on(table.workspaceID, table.timePeriodEnd),
    uniqueIndex("plan_subscription_workspace_active")
      .on(table.workspaceID)
      .where(sql`${table.status} = 'active' and ${table.timeDeleted} is null`),
    check("plan_subscription_plan_check", sql`${table.plan} in ('basic', 'pro', 'max')`),
    check("plan_subscription_status_check", sql`${table.status} in ('active', 'expired', 'cancelled', 'refunded')`),
    check("plan_subscription_period_check", sql`${table.timePeriodEnd} > ${table.timePeriodStart}`),
  ],
)

export const LiteTable = sqliteTable(
  "lite",
  {
    ...workspaceColumns,
    ...timestamps,
    userID: ulid("user_id").notNull(),
    rollingUsage: integer("rolling_usage"),
    weeklyUsage: integer("weekly_usage"),
    monthlyUsage: integer("monthly_usage"),
    timeRollingUpdated: utc("time_rolling_updated"),
    timeWeeklyUpdated: utc("time_weekly_updated"),
    timeMonthlyUpdated: utc("time_monthly_updated"),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("lite_workspace_user_id").on(table.workspaceID, table.userID)],
)

export const PaymentTable = sqliteTable(
  "payment",
  {
    ...workspaceColumns,
    ...timestamps,
    customerID: text("customer_id", { length: 255 }),
    invoiceID: text("invoice_id", { length: 255 }),
    paymentID: text("payment_id", { length: 255 }),
    amount: currency("amount").notNull(),
    timeRefunded: utc("time_refunded"),
    enrichment: text("enrichment", { mode: "json" }).$type<
      | {
          type: "subscription" | "lite"
          currency?: "inr"
          couponID?: string
        }
      | { type: "credit" }
    >(),
  },
  (table) => [
    ...workspaceIndexes(table),
    check("payment_enrichment_json_check", sql`${table.enrichment} is null or json_valid(${table.enrichment})`),
  ],
)

export const PaymentInvoiceTable = sqliteTable(
  "payment_invoice",
  {
    id: id(),
    workspace_id: ulid("workspace_id").notNull(),
    provider: text("provider", { enum: PaymentProviders }).notNull(),
    merchant_account_id: text("merchant_account_id", { length: 255 }).notNull(),
    external_invoice_id: text("external_invoice_id", { length: 255 }).notNull(),
    external_payment_id: text("external_payment_id", { length: 255 }),
    purpose: text("purpose", { enum: PaymentPurposes }).notNull(),
    plan: text("plan", { enum: PlanNames }),
    amount: integer("amount").notNull(),
    currency: text("currency", { enum: ["MNT"] })
      .notNull()
      .default("MNT"),
    status: text("status", { enum: PaymentInvoiceStatuses }).notNull().default("created"),
    time_expires: utc("time_expires"),
    time_failed: utc("time_failed"),
    time_expired: utc("time_expired"),
    time_cancelled: utc("time_cancelled"),
    time_verified: utc("time_verified"),
    time_refunded: utc("time_refunded"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("payment_invoice_workspace_time_created").on(table.workspace_id, table.timeCreated),
    uniqueIndex("payment_invoice_merchant_external_invoice").on(
      table.provider,
      table.merchant_account_id,
      table.external_invoice_id,
    ),
    uniqueIndex("payment_invoice_merchant_external_payment").on(
      table.provider,
      table.merchant_account_id,
      table.external_payment_id,
    ),
    check("payment_invoice_provider_check", sql`${table.provider} in ('qpay', 'bonum')`),
    check("payment_invoice_purpose_check", sql`${table.purpose} in ('subscription', 'credit')`),
    check(
      "payment_invoice_plan_check",
      sql`(${table.purpose} = 'subscription' and ${table.plan} in ('basic', 'pro', 'max'))
        or (${table.purpose} = 'credit' and ${table.plan} is null)`,
    ),
    check("payment_invoice_amount_check", sql`${table.amount} > 0`),
    check("payment_invoice_currency_check", sql`${table.currency} = 'MNT'`),
    check(
      "payment_invoice_status_check",
      sql`${table.status} in ('created', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')`,
    ),
  ],
)

export const PaymentCheckoutTable = sqliteTable(
  "payment_checkout",
  {
    id: id(),
    workspace_id: ulid("workspace_id").notNull(),
    account_id: ulid("account_id").notNull(),
    request_key: text("request_key", { length: 64 }).notNull(),
    provider: text("provider", { enum: PaymentProviders }).notNull(),
    merchant_account_id: text("merchant_account_id", { length: 255 }).notNull(),
    external_invoice_id: text("external_invoice_id", { length: 255 }),
    purpose: text("purpose", { enum: PaymentPurposes }).notNull(),
    plan: text("plan", { enum: PlanNames }),
    amount: integer("amount").notNull(),
    currency: text("currency", { enum: ["MNT"] })
      .notNull()
      .default("MNT"),
    checkout: text("checkout", { mode: "json" }).$type<{
      provider: (typeof PaymentProviders)[number]
      merchantAccountID: string
      externalInvoiceID: string
      qrText?: string
      qrImage?: string
      checkoutURL?: string
      deepLinks: Array<{ name: string; description: string; link: string }>
    }>(),
    creation_error_code: text("creation_error_code", { length: 64 }),
    status: text("status", { enum: PaymentCheckoutStatuses }).notNull().default("creating"),
    time_expires: utc("time_expires").notNull(),
    time_ready: utc("time_ready"),
    time_failed: utc("time_failed"),
    time_expired: utc("time_expired"),
    time_cancelled: utc("time_cancelled"),
    time_paid: utc("time_paid"),
    time_refunded: utc("time_refunded"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("payment_checkout_workspace_request_key").on(table.workspace_id, table.request_key),
    uniqueIndex("payment_checkout_workspace_open_subscription")
      .on(table.workspace_id)
      .where(
        sql`${table.purpose} = 'subscription'
          and ${table.status} in ('creating', 'unknown', 'ready', 'pending')
          and ${table.timeDeleted} is null`,
      ),
    uniqueIndex("payment_checkout_merchant_external_invoice").on(
      table.provider,
      table.merchant_account_id,
      table.external_invoice_id,
    ),
    index("payment_checkout_status_time_expires").on(table.status, table.time_expires),
    check("payment_checkout_provider_check", sql`${table.provider} in ('qpay', 'bonum')`),
    check("payment_checkout_purpose_check", sql`${table.purpose} in ('subscription', 'credit')`),
    check(
      "payment_checkout_plan_check",
      sql`(${table.purpose} = 'subscription' and ${table.plan} in ('basic', 'pro', 'max'))
        or (${table.purpose} = 'credit' and ${table.plan} is null)`,
    ),
    check("payment_checkout_amount_check", sql`${table.amount} > 0`),
    check("payment_checkout_currency_check", sql`${table.currency} = 'MNT'`),
    check("payment_checkout_json_check", sql`${table.checkout} is null or json_valid(${table.checkout})`),
    check(
      "payment_checkout_status_check",
      sql`${table.status} in ('creating', 'unknown', 'ready', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')`,
    ),
    check(
      "payment_checkout_ready_check",
      sql`(${table.status} in ('creating', 'unknown') and ${table.external_invoice_id} is null and ${table.checkout} is null)
        or (${table.status} in ('failed', 'expired') and (
          (${table.external_invoice_id} is null and ${table.checkout} is null)
          or (${table.external_invoice_id} is not null and ${table.checkout} is not null)
        ))
        or (${table.status} in ('ready', 'pending', 'paid', 'cancelled', 'refunded')
          and ${table.external_invoice_id} is not null and ${table.checkout} is not null)`,
    ),
  ],
)

export const PaymentCancellationTable = sqliteTable(
  "payment_cancellation",
  {
    invoice_id: ulid("invoice_id").notNull(),
    workspace_id: ulid("workspace_id").notNull(),
    account_id: ulid("account_id").notNull(),
    request_key: text("request_key", { length: 64 }).notNull(),
    provider: text("provider", { enum: PaymentProviders }).notNull(),
    merchant_account_id: text("merchant_account_id", { length: 255 }).notNull(),
    external_invoice_id: text("external_invoice_id", { length: 255 }).notNull(),
    status: text("status", { enum: PaymentCancellationStatuses }).notNull().default("requested"),
    error_code: text("error_code", { length: 64 }),
    time_requested: utc("time_requested").notNull(),
    time_completed: utc("time_completed"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.invoice_id] }),
    uniqueIndex("payment_cancellation_workspace_request_key").on(table.workspace_id, table.request_key),
    uniqueIndex("payment_cancellation_merchant_external_invoice").on(
      table.provider,
      table.merchant_account_id,
      table.external_invoice_id,
    ),
    index("payment_cancellation_status_time_requested").on(table.status, table.time_requested),
    check("payment_cancellation_provider_check", sql`${table.provider} in ('qpay', 'bonum')`),
    check("payment_cancellation_status_check", sql`${table.status} in ('requested', 'unknown', 'cancelled', 'failed')`),
    check(
      "payment_cancellation_completion_check",
      sql`(${table.status} in ('requested', 'unknown') and ${table.time_completed} is null)
        or (${table.status} in ('cancelled', 'failed') and ${table.time_completed} is not null)`,
    ),
  ],
)

export const PaymentEventTable = sqliteTable(
  "payment_event",
  {
    id: id(),
    invoice_id: ulid("invoice_id").notNull(),
    workspace_id: ulid("workspace_id").notNull(),
    provider: text("provider", { enum: PaymentProviders }).notNull(),
    merchant_account_id: text("merchant_account_id", { length: 255 }).notNull(),
    external_event_id: text("external_event_id", { length: 255 }).notNull(),
    external_invoice_id: text("external_invoice_id", { length: 255 }).notNull(),
    external_payment_id: text("external_payment_id", { length: 255 }),
    amount: integer("amount"),
    currency: text("currency", { enum: ["MNT"] }),
    type: text("type", { enum: PaymentEventTypes }).notNull(),
    outcome: text("outcome", { enum: PaymentEventOutcomes }).notNull(),
    from_status: text("from_status", { enum: PaymentInvoiceStatuses }).notNull(),
    to_status: text("to_status", { enum: PaymentInvoiceStatuses }).notNull(),
    payload_hash: text("payload_hash", { length: 64 }).notNull(),
    time_occurred: utc("time_occurred").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("payment_event_invoice_time_created").on(table.invoice_id, table.timeCreated),
    index("payment_event_workspace_time_created").on(table.workspace_id, table.timeCreated),
    uniqueIndex("payment_event_merchant_external_event").on(
      table.provider,
      table.merchant_account_id,
      table.external_event_id,
    ),
    check("payment_event_provider_check", sql`${table.provider} in ('qpay', 'bonum')`),
    check(
      "payment_event_amount_currency_check",
      sql`(${table.amount} is null and ${table.currency} is null)
        or (${table.amount} > 0 and ${table.currency} = 'MNT')`,
    ),
    check(
      "payment_event_type_check",
      sql`${table.type} in ('pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')`,
    ),
    check("payment_event_outcome_check", sql`${table.outcome} in ('applied', 'noop', 'rejected')`),
    check(
      "payment_event_from_status_check",
      sql`${table.from_status} in ('created', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')`,
    ),
    check(
      "payment_event_to_status_check",
      sql`${table.to_status} in ('created', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')`,
    ),
    check("payment_event_payload_hash_check", sql`length(${table.payload_hash}) = 64`),
  ],
)

export const UsageTable = sqliteTable(
  "usage",
  {
    ...workspaceColumns,
    ...timestamps,
    model: text("model", { length: 255 }).notNull(),
    provider: text("provider", { length: 255 }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWrite5mTokens: integer("cache_write_5m_tokens"),
    cacheWrite1hTokens: integer("cache_write_1h_tokens"),
    cost: currency("cost").notNull(),
    inputCost: currency("input_cost"),
    outputCost: currency("output_cost"),
    cacheReadCost: currency("cache_read_cost"),
    cacheWriteCost: currency("cache_write_cost"),
    country: text("country", { length: 2 }),
    continent: text("continent", { length: 2 }),
    keyID: ulid("key_id"),
    sessionID: text("session_id", { length: 30 }),
    enrichment: text("enrichment", { mode: "json" }).$type<{
      plan: (typeof PlanNames)[number] | "byok" | "legacy-lite" | "balance"
    }>(),
  },
  (table) => [
    ...workspaceIndexes(table),
    index("usage_workspace_time_created").on(table.workspaceID, table.timeCreated),
    index("usage_time_model_provider").on(table.timeCreated, table.model, table.provider),
    check("usage_enrichment_json_check", sql`${table.enrichment} is null or json_valid(${table.enrichment})`),
  ],
)

export const CouponTable = sqliteTable(
  "coupon",
  {
    email: text("email", { length: 255 }),
    type: text("type", { enum: CouponType }).notNull(),
    timeRedeemed: utc("time_redeemed"),
  },
  (table) => [
    primaryKey({ columns: [table.email, table.type] }),
    check(
      "coupon_type_check",
      sql`${table.type} in ('BUILDATHON', 'GO1MONTH50', 'GOFREEMONTH', 'GO3MONTHS100', 'GO6MONTHS100', 'GO12MONTHS100')`,
    ),
  ],
)

export const IpTable = sqliteTable(
  "ip",
  {
    ip: text("ip", { length: 45 }).notNull(),
    ...timestamps,
    usage: integer("usage"),
  },
  (table) => [primaryKey({ columns: [table.ip] })],
)

export const IpRateLimitTable = sqliteTable(
  "ip_rate_limit",
  {
    ip: text("ip", { length: 45 }).notNull(),
    interval: text("interval", { length: 10 }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ip, table.interval] })],
)

export const KeyRateLimitTable = sqliteTable(
  "key_rate_limit",
  {
    key: text("key", { length: 255 }).notNull(),
    interval: text("interval", { length: 40 }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.interval] })],
)

export const ModelTpmRateLimitTable = sqliteTable(
  "model_tpm_rate_limit",
  {
    id: text("id", { length: 255 }).notNull(),
    interval: integer("interval").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.interval] })],
)

export const ModelTpsRateLimitTable = sqliteTable(
  "model_tps_rate_limit",
  {
    id: text("id", { length: 255 }).notNull(),
    interval: integer("interval").notNull(),
    qualify: integer("qualify").notNull(),
    unqualify: integer("unqualify").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.interval] })],
)

export const ModelStickyProviderTable = sqliteTable(
  "model_sticky_provider",
  {
    id: text("id", { length: 255 }).notNull(),
    ...timestamps,
    providerId: text("provider_id", { length: 255 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
)

export const KeyTable = sqliteTable(
  "key",
  {
    ...workspaceColumns,
    ...timestamps,
    name: text("name", { length: 255 }).notNull(),
    key: text("key", { length: 255 }).notNull(),
    userID: ulid("user_id").notNull(),
    timeUsed: utc("time_used"),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("key_global_key").on(table.key)],
)

export const ModelTable = sqliteTable(
  "model",
  {
    ...workspaceColumns,
    ...timestamps,
    model: text("model", { length: 64 }).notNull(),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("model_workspace_model").on(table.workspaceID, table.model)],
)

export const ProviderTable = sqliteTable(
  "provider",
  {
    ...workspaceColumns,
    ...timestamps,
    provider: text("provider", { length: 64 }).notNull(),
    credentials: text("credentials").notNull(),
  },
  (table) => [
    ...workspaceIndexes(table),
    uniqueIndex("provider_workspace_provider").on(table.workspaceID, table.provider),
  ],
)

export const ReferralCodeTable = sqliteTable(
  "referral_code",
  {
    workspaceID: ulid("workspace_id").notNull(),
    code: text("code", { length: 10 }).notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.workspaceID] }), uniqueIndex("referral_code_code").on(table.code)],
)

export const ReferralTable = sqliteTable(
  "referral",
  {
    ...workspaceColumns,
    ...timestamps,
    inviteeAccountID: ulid("invitee_account_id").notNull(),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("referral_invitee_account_id").on(table.inviteeAccountID)],
)

export const ReferralRewardTable = sqliteTable(
  "referral_reward",
  {
    workspaceID: ulid("workspace_id").notNull(),
    referralID: ulid("referral_id").notNull(),
    ...timestamps,
    amount: currency("amount").notNull(),
    timeApplied: utc("time_applied"),
  },
  (table) => [primaryKey({ columns: [table.workspaceID, table.referralID] })],
)
