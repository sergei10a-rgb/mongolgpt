import { PlanNames } from "@mongolgpt/account-contract"
import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { currency, id, timestamps, ulid, utc, workspaceColumns } from "../drizzle-d1/types"

export const AuthProvider = ["email", "github", "google"] as const
export const AccountStatuses = ["active", "suspended"] as const
export const AccountDeletionStatuses = ["requested", "processing", "completed", "failed", "cancelled"] as const
export const UserRole = ["admin", "member"] as const
export const PlatformAdminRoles = ["owner", "administrator", "support", "finance", "operations"] as const
export const PlatformAdminStatuses = ["active", "suspended"] as const
export const AdminAuditOutcomes = ["success", "denied", "failure"] as const
export { PlanNames }
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
export const PaymentRefundStatuses = ["requested", "unknown", "refunded", "failed"] as const
export const PaymentEventTypes = ["pending", "paid", "failed", "expired", "cancelled", "refunded"] as const
export const PaymentEventOutcomes = ["applied", "noop", "rejected"] as const
export const PaymentRecoveryStatuses = ["pending", "processing", "resolved", "manual_review"] as const
export const PlanSubscriptionStatuses = ["active", "expired", "cancelled", "refunded"] as const
export const FinanceCurrencies = ["MNT", "USD"] as const
export const FinanceCostCategories = ["model_cost", "payment_fee", "tax", "adjustment"] as const
export const FinanceCostDirections = ["debit", "credit"] as const
export const FinanceCostBases = ["estimated", "actual", "allocated"] as const
export const FinanceCostSourceTypes = ["usage", "provider_statement", "payment_settlement", "manual"] as const
export const FinanceCostValuationMethods = ["historical_spot", "provider_settlement", "manual"] as const
export const FinancePaymentSettlementKinds = ["payment", "refund", "adjustment"] as const
export const NewsletterSubscriberStatus = ["active", "unsubscribed"] as const
export const NewsletterSubscriberSource = ["console", "stats"] as const
export const EnterpriseInquiryStatus = ["new", "reviewing", "resolved", "spam"] as const
export const EnterpriseInquirySource = ["enterprise"] as const
export const SupportTicketCategories = ["account", "billing", "technical", "feedback", "other"] as const
export const SupportTicketStatuses = ["open", "pending_user", "pending_support", "resolved", "closed"] as const
export const SupportTicketPriorities = ["normal", "high", "urgent"] as const
export const SupportMessageAuthorTypes = ["customer", "admin"] as const
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
    status: text({ enum: AccountStatuses }).notNull().default("active"),
    auth_version: integer().notNull().default(0),
    suspension_reason: text({ length: 500 }),
    suspended_by: ulid("suspended_by"),
    time_suspended: utc("time_suspended"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("account_status_id").on(table.status, table.id),
    check("account_status_check", sql`${table.status} in ('active', 'suspended')`),
    check("account_auth_version_check", sql`${table.auth_version} >= 0`),
    check(
      "account_suspension_check",
      sql`(
        ${table.status} = 'active'
        and ${table.suspension_reason} is null
        and ${table.suspended_by} is null
        and ${table.time_suspended} is null
      ) or (
        ${table.status} = 'suspended'
        and length(trim(${table.suspension_reason})) between 10 and 500
        and ${table.suspended_by} is not null
        and ${table.time_suspended} is not null
      )`,
    ),
  ],
)

export const AccountDeletionTable = sqliteTable(
  "account_deletion",
  {
    id: id(),
    account_id: ulid("account_id").notNull(),
    status: text({ enum: AccountDeletionStatuses }).notNull().default("requested"),
    attempts: integer().notNull().default(0),
    last_error_code: text({ length: 64 }),
    time_eligible: utc("time_eligible").notNull(),
    time_started: utc("time_started"),
    time_completed: utc("time_completed"),
    time_cancelled: utc("time_cancelled"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("account_deletion_account_id").on(table.account_id),
    index("account_deletion_status_eligible").on(table.status, table.time_eligible),
    check(
      "account_deletion_status_check",
      sql`${table.status} in ('requested', 'processing', 'completed', 'failed', 'cancelled')`,
    ),
    check("account_deletion_attempts_check", sql`${table.attempts} >= 0 and ${table.attempts} <= 5`),
    check(
      "account_deletion_state_check",
      sql`(
        ${table.status} = 'requested'
        and ${table.time_started} is null
        and ${table.time_completed} is null
        and ${table.time_cancelled} is null
        and ${table.last_error_code} is null
      ) or (
        ${table.status} = 'failed'
        and ${table.time_started} is not null
        and ${table.time_completed} is null
        and ${table.time_cancelled} is null
        and length(trim(${table.last_error_code})) between 1 and 64
      ) or (
        ${table.status} = 'processing'
        and ${table.time_started} is not null
        and ${table.time_completed} is null
        and ${table.time_cancelled} is null
        and ${table.last_error_code} is null
      ) or (
        ${table.status} = 'completed'
        and ${table.time_started} is not null
        and ${table.time_completed} is not null
        and ${table.time_cancelled} is null
        and ${table.last_error_code} is null
      ) or (
        ${table.status} = 'cancelled'
        and ${table.time_started} is null
        and ${table.time_completed} is null
        and ${table.time_cancelled} is not null
        and ${table.last_error_code} is null
      )`,
    ),
  ],
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

export const PlatformAdminTable = sqliteTable(
  "platform_admin",
  {
    id: id(),
    email: text("email", { length: 254 }).notNull(),
    access_subject: text("access_subject", { length: 255 }),
    role: text("role", { enum: PlatformAdminRoles }).notNull(),
    status: text("status", { enum: PlatformAdminStatuses }).notNull().default("active"),
    time_last_seen: utc("time_last_seen"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("platform_admin_email").on(table.email),
    uniqueIndex("platform_admin_access_subject").on(table.access_subject),
    index("platform_admin_status_role").on(table.status, table.role),
    check(
      "platform_admin_email_normalized_check",
      sql`${table.email} = lower(trim(${table.email})) and length(${table.email}) between 3 and 254`,
    ),
    check(
      "platform_admin_role_check",
      sql`${table.role} in ('owner', 'administrator', 'support', 'finance', 'operations')`,
    ),
    check("platform_admin_status_check", sql`${table.status} in ('active', 'suspended')`),
  ],
)

export const AdminAuditLogTable = sqliteTable(
  "admin_audit_log",
  {
    id: id(),
    admin_id: ulid("admin_id"),
    actor_email: text("actor_email", { length: 254 }).notNull(),
    action: text("action", { length: 128 }).notNull(),
    target_type: text("target_type", { length: 64 }),
    target_id: text("target_id", { length: 255 }),
    outcome: text("outcome", { enum: AdminAuditOutcomes }).notNull(),
    request_id: text("request_id", { length: 128 }).notNull(),
    source_ip: text("source_ip", { length: 45 }),
    user_agent: text("user_agent", { length: 512 }),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, string | number | boolean | null>>(),
    time_created: utc("time_created").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("admin_audit_log_time_created").on(table.time_created),
    index("admin_audit_log_admin_time_created").on(table.admin_id, table.time_created),
    index("admin_audit_log_action_time_created").on(table.action, table.time_created),
    check("admin_audit_log_outcome_check", sql`${table.outcome} in ('success', 'denied', 'failure')`),
    check("admin_audit_log_metadata_json_check", sql`${table.metadata} is null or json_valid(${table.metadata})`),
  ],
)

export const PlanConfigVersionTable = sqliteTable(
  "plan_config_version",
  {
    id: id(),
    revision: integer("revision").notNull(),
    limits: text("limits", { mode: "json" }).$type<unknown>().notNull(),
    created_by: ulid("created_by").notNull(),
    source_version_id: ulid("source_version_id"),
    note: text("note", { length: 500 }),
    time_created: utc("time_created").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("plan_config_version_revision").on(table.revision),
    index("plan_config_version_time_created").on(table.time_created),
    index("plan_config_version_source_version").on(table.source_version_id),
    check("plan_config_version_revision_check", sql`${table.revision} > 0`),
    check("plan_config_version_limits_json_check", sql`json_valid(${table.limits})`),
    check(
      "plan_config_version_note_check",
      sql`${table.note} is null or length(trim(${table.note})) between 1 and 500`,
    ),
  ],
)

export const PlanConfigActiveTable = sqliteTable(
  "plan_config_active",
  {
    id: integer("id").primaryKey(),
    active_version_id: ulid("active_version_id").notNull(),
    revision: integer("revision").notNull().default(0),
    updated_by: ulid("updated_by").notNull(),
    time_updated: utc("time_updated").notNull().defaultNow(),
  },
  (table) => [
    index("plan_config_active_version").on(table.active_version_id),
    check("plan_config_active_singleton_check", sql`${table.id} = 1`),
    check("plan_config_active_revision_check", sql`${table.revision} >= 0`),
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

export const SupportTicketTable = sqliteTable(
  "support_ticket",
  {
    id: ulid("id").notNull(),
    account_id: ulid("account_id").notNull(),
    requester_email: text("requester_email", { length: 254 }).notNull(),
    workspace_id: ulid("workspace_id"),
    subject: text("subject", { length: 160 }).notNull(),
    category: text("category", { enum: SupportTicketCategories }).notNull(),
    status: text("status", { enum: SupportTicketStatuses }).notNull().default("open"),
    priority: text("priority", { enum: SupportTicketPriorities }).notNull().default("normal"),
    assigned_admin_id: ulid("assigned_admin_id"),
    lock_version: integer("lock_version").notNull().default(0),
    last_message_at: utc("last_message_at").notNull(),
    time_resolved: utc("time_resolved"),
    time_closed: utc("time_closed"),
    time_created: utc("time_created").notNull().defaultNow(),
    time_updated: utc("time_updated").notNull().defaultNow(),
    time_deleted: utc("time_deleted"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("support_ticket_account_last_message").on(table.account_id, table.last_message_at),
    index("support_ticket_workspace_last_message").on(table.workspace_id, table.last_message_at),
    index("support_ticket_status_priority_last_message").on(table.status, table.priority, table.last_message_at),
    check("support_ticket_id_check", sql`length(${table.id}) = 30 and substr(${table.id}, 1, 4) = 'spt_'`),
    check(
      "support_ticket_requester_email_check",
      sql`${table.requester_email} = lower(trim(${table.requester_email})) and length(${table.requester_email}) between 3 and 254`,
    ),
    check("support_ticket_subject_check", sql`length(trim(${table.subject})) between 1 and 160`),
    check(
      "support_ticket_category_check",
      sql`${table.category} in ('account', 'billing', 'technical', 'feedback', 'other')`,
    ),
    check(
      "support_ticket_status_check",
      sql`${table.status} in ('open', 'pending_user', 'pending_support', 'resolved', 'closed')`,
    ),
    check("support_ticket_priority_check", sql`${table.priority} in ('normal', 'high', 'urgent')`),
    check("support_ticket_lock_version_check", sql`${table.lock_version} >= 0`),
    check(
      "support_ticket_status_time_check",
      sql`(${table.status} in ('open', 'pending_user', 'pending_support') and ${table.time_resolved} is null and ${table.time_closed} is null)
        or (${table.status} = 'resolved' and ${table.time_resolved} is not null and ${table.time_closed} is null)
        or (${table.status} = 'closed' and ${table.time_resolved} is not null and ${table.time_closed} is not null and ${table.time_closed} >= ${table.time_resolved})`,
    ),
  ],
)

export const SupportMessageTable = sqliteTable(
  "support_message",
  {
    id: ulid("id").notNull(),
    ticket_id: ulid("ticket_id").notNull(),
    author_type: text("author_type", { enum: SupportMessageAuthorTypes }).notNull(),
    account_id: ulid("account_id"),
    admin_id: ulid("admin_id"),
    body: text("body", { length: 5_000 }).notNull(),
    internal: integer("internal", { mode: "boolean" }).notNull().default(false),
    time_created: utc("time_created").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("support_message_ticket_time").on(table.ticket_id, table.time_created),
    check("support_message_id_check", sql`length(${table.id}) = 30 and substr(${table.id}, 1, 4) = 'spm_'`),
    check("support_message_body_check", sql`length(trim(${table.body})) between 1 and 5000`),
    check("support_message_author_type_check", sql`${table.author_type} in ('customer', 'admin')`),
    check(
      "support_message_author_check",
      sql`(${table.author_type} = 'customer' and ${table.account_id} is not null and ${table.admin_id} is null and ${table.internal} = 0)
        or (${table.author_type} = 'admin' and ${table.account_id} is null and ${table.admin_id} is not null)`,
    ),
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
    weeklyRequests: integer("weekly_requests"),
    monthlyCost: integer("monthly_cost"),
    monthlyTokens: integer("monthly_tokens"),
    monthlyRequests: integer("monthly_requests"),
    timeRollingUpdated: utc("time_rolling_updated"),
    timeFixedUpdated: utc("time_fixed_updated"),
    timeWeeklyTokensUpdated: utc("time_weekly_tokens_updated"),
    timeWeeklyRequestsUpdated: utc("time_weekly_requests_updated"),
    timeMonthlyCostUpdated: utc("time_monthly_cost_updated"),
    timeMonthlyTokensUpdated: utc("time_monthly_tokens_updated"),
    timeMonthlyRequestsUpdated: utc("time_monthly_requests_updated"),
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

export const PaymentRefundTable = sqliteTable(
  "payment_refund",
  {
    invoice_id: ulid("invoice_id").notNull(),
    workspace_id: ulid("workspace_id").notNull(),
    account_id: ulid("account_id").notNull(),
    request_key: text("request_key", { length: 64 }).notNull(),
    provider: text("provider", { enum: PaymentProviders }).notNull(),
    merchant_account_id: text("merchant_account_id", { length: 255 }).notNull(),
    external_invoice_id: text("external_invoice_id", { length: 255 }).notNull(),
    external_payment_id: text("external_payment_id", { length: 255 }).notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency", { enum: ["MNT"] })
      .notNull()
      .default("MNT"),
    status: text("status", { enum: PaymentRefundStatuses }).notNull().default("requested"),
    error_code: text("error_code", { length: 64 }),
    provider_payload_hash: text("provider_payload_hash", { length: 64 }),
    time_requested: utc("time_requested").notNull(),
    time_completed: utc("time_completed"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.invoice_id] }),
    uniqueIndex("payment_refund_workspace_request_key").on(table.workspace_id, table.request_key),
    uniqueIndex("payment_refund_merchant_external_payment").on(
      table.provider,
      table.merchant_account_id,
      table.external_payment_id,
    ),
    index("payment_refund_status_time_requested").on(table.status, table.time_requested),
    check("payment_refund_provider_check", sql`${table.provider} in ('qpay', 'bonum')`),
    check("payment_refund_amount_check", sql`${table.amount} > 0`),
    check("payment_refund_currency_check", sql`${table.currency} = 'MNT'`),
    check("payment_refund_status_check", sql`${table.status} in ('requested', 'unknown', 'refunded', 'failed')`),
    check(
      "payment_refund_completion_check",
      sql`(${table.status} in ('requested', 'unknown') and ${table.time_completed} is null)
        or (${table.status} in ('refunded', 'failed') and ${table.time_completed} is not null)`,
    ),
    check(
      "payment_refund_provider_payload_hash_check",
      sql`${table.provider_payload_hash} is null or length(${table.provider_payload_hash}) = 64`,
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

export const PaymentRecoveryTable = sqliteTable(
  "payment_recovery",
  {
    id: id(),
    message_hash: text("message_hash", { length: 64 }).notNull(),
    provider: text("provider", { enum: PaymentProviders }),
    merchant_account_id: text("merchant_account_id", { length: 255 }),
    external_event_id: text("external_event_id", { length: 255 }),
    external_invoice_id: text("external_invoice_id", { length: 255 }),
    payload_hash: text("payload_hash", { length: 64 }),
    event: text("event", { mode: "json" }).$type<unknown>(),
    status: text("status", { enum: PaymentRecoveryStatuses }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    last_error_code: text("last_error_code", { length: 64 }),
    time_next_attempt: utc("time_next_attempt"),
    time_lease_expires: utc("time_lease_expires"),
    time_resolved: utc("time_resolved"),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("payment_recovery_message_hash").on(table.message_hash),
    uniqueIndex("payment_recovery_merchant_external_event").on(
      table.provider,
      table.merchant_account_id,
      table.external_event_id,
    ),
    index("payment_recovery_status_next_attempt").on(table.status, table.time_next_attempt),
    index("payment_recovery_status_lease_expires").on(table.status, table.time_lease_expires),
    check("payment_recovery_message_hash_check", sql`length(${table.message_hash}) = 64`),
    check("payment_recovery_provider_check", sql`${table.provider} is null or ${table.provider} in ('qpay', 'bonum')`),
    check(
      "payment_recovery_payload_hash_check",
      sql`${table.payload_hash} is null or length(${table.payload_hash}) = 64`,
    ),
    check("payment_recovery_event_json_check", sql`${table.event} is null or json_valid(${table.event})`),
    check(
      "payment_recovery_identity_check",
      sql`(${table.event} is null
          and ${table.provider} is null
          and ${table.merchant_account_id} is null
          and ${table.external_event_id} is null
          and ${table.external_invoice_id} is null
          and ${table.payload_hash} is null)
        or (${table.event} is not null
          and ${table.provider} is not null
          and ${table.merchant_account_id} is not null
          and ${table.external_event_id} is not null
          and ${table.external_invoice_id} is not null
          and ${table.payload_hash} is not null)`,
    ),
    check(
      "payment_recovery_status_check",
      sql`${table.status} in ('pending', 'processing', 'resolved', 'manual_review')`,
    ),
    check("payment_recovery_attempts_check", sql`${table.attempts} >= 0 and ${table.attempts} <= 6`),
    check(
      "payment_recovery_state_check",
      sql`(${table.status} = 'pending'
          and ${table.event} is not null
          and ${table.time_next_attempt} is not null
          and ${table.time_lease_expires} is null
          and ${table.time_resolved} is null)
        or (${table.status} = 'processing'
          and ${table.event} is not null
          and ${table.time_next_attempt} is null
          and ${table.time_lease_expires} is not null
          and ${table.time_resolved} is null
          and ${table.last_error_code} is null)
        or (${table.status} = 'resolved'
          and ${table.event} is not null
          and ${table.time_next_attempt} is null
          and ${table.time_lease_expires} is null
          and ${table.time_resolved} is not null
          and ${table.last_error_code} is null)
        or (${table.status} = 'manual_review'
          and ${table.time_next_attempt} is null
          and ${table.time_lease_expires} is null
          and ${table.time_resolved} is null
          and length(trim(${table.last_error_code})) between 1 and 64)`,
    ),
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

export const FinanceFxRateTable = sqliteTable(
  "finance_fx_rate",
  {
    id: id(),
    base_currency: text("base_currency", { enum: ["USD"] })
      .notNull()
      .default("USD"),
    quote_currency: text("quote_currency", { enum: ["MNT"] })
      .notNull()
      .default("MNT"),
    rate_micromnt_per_usd: integer("rate_micromnt_per_usd").notNull(),
    source: text("source", { length: 64 }).notNull(),
    source_reference: text("source_reference", { length: 255 }).notNull(),
    idempotency_key: text("idempotency_key", { length: 255 }).notNull(),
    payload_hash: text("payload_hash", { length: 64 }).notNull(),
    time_effective: utc("time_effective").notNull(),
    time_created: utc("time_created").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("finance_fx_rate_idempotency_key").on(table.idempotency_key),
    uniqueIndex("finance_fx_rate_source_reference").on(table.source, table.source_reference),
    index("finance_fx_rate_pair_time_effective").on(table.base_currency, table.quote_currency, table.time_effective),
    check("finance_fx_rate_pair_check", sql`${table.base_currency} = 'USD' and ${table.quote_currency} = 'MNT'`),
    check("finance_fx_rate_value_check", sql`${table.rate_micromnt_per_usd} > 0`),
    check(
      "finance_fx_rate_identity_check",
      sql`length(trim(${table.source})) between 1 and 64
        and length(trim(${table.source_reference})) between 1 and 255
        and length(trim(${table.idempotency_key})) between 1 and 255`,
    ),
    check("finance_fx_rate_payload_hash_check", sql`length(${table.payload_hash}) = 64`),
  ],
)

export const FinanceCostEntryTable = sqliteTable(
  "finance_cost_entry",
  {
    id: id(),
    workspace_id: ulid("workspace_id").notNull(),
    category: text("category", { enum: FinanceCostCategories }).notNull(),
    direction: text("direction", { enum: FinanceCostDirections }).notNull(),
    basis: text("basis", { enum: FinanceCostBases }).notNull(),
    source_type: text("source_type", { enum: FinanceCostSourceTypes }).notNull(),
    source_reference: text("source_reference", { length: 255 }).notNull(),
    usage_id: ulid("usage_id"),
    payment_invoice_id: ulid("payment_invoice_id"),
    payment_event_id: ulid("payment_event_id"),
    provider: text("provider", { length: 255 }),
    model: text("model", { length: 255 }),
    original_amount: integer("original_amount").notNull(),
    original_currency: text("original_currency", { enum: FinanceCurrencies }).notNull(),
    fx_rate_id: ulid("fx_rate_id"),
    amount_mnt_micros: integer("amount_mnt_micros"),
    idempotency_key: text("idempotency_key", { length: 255 }).notNull(),
    payload_hash: text("payload_hash", { length: 64 }).notNull(),
    time_effective: utc("time_effective").notNull(),
    time_created: utc("time_created").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("finance_cost_entry_idempotency_key").on(table.idempotency_key),
    uniqueIndex("finance_cost_entry_source_identity").on(
      table.source_type,
      table.source_reference,
      table.category,
      table.direction,
      table.basis,
    ),
    index("finance_cost_entry_workspace_time_effective").on(table.workspace_id, table.time_effective),
    index("finance_cost_entry_usage_id").on(table.usage_id),
    index("finance_cost_entry_payment_invoice_id").on(table.payment_invoice_id),
    index("finance_cost_entry_provider_time_effective").on(table.provider, table.time_effective),
    check(
      "finance_cost_entry_category_check",
      sql`${table.category} in ('model_cost', 'payment_fee', 'tax', 'adjustment')`,
    ),
    check("finance_cost_entry_direction_check", sql`${table.direction} in ('debit', 'credit')`),
    check("finance_cost_entry_basis_check", sql`${table.basis} in ('estimated', 'actual', 'allocated')`),
    check(
      "finance_cost_entry_source_type_check",
      sql`${table.source_type} in ('usage', 'provider_statement', 'payment_settlement', 'manual')`,
    ),
    check("finance_cost_entry_original_amount_check", sql`${table.original_amount} > 0`),
    check(
      "finance_cost_entry_currency_check",
      sql`(
        ${table.original_currency} = 'MNT'
        and ${table.fx_rate_id} is null
        and ${table.amount_mnt_micros} > 0
      ) or (
        ${table.original_currency} = 'USD'
        and (
          (${table.fx_rate_id} is null and ${table.amount_mnt_micros} is null)
          or (${table.fx_rate_id} is not null and ${table.amount_mnt_micros} > 0)
        )
      )`,
    ),
    check(
      "finance_cost_entry_source_reference_check",
      sql`length(trim(${table.source_reference})) between 1 and 255
        and length(trim(${table.idempotency_key})) between 1 and 255`,
    ),
    check(
      "finance_cost_entry_source_link_check",
      sql`(${table.source_type} = 'usage' and ${table.usage_id} is not null and ${table.source_reference} = ${table.usage_id})
        or ${table.source_type} = 'provider_statement'
        or (${table.source_type} = 'payment_settlement'
          and (${table.payment_invoice_id} is not null or ${table.payment_event_id} is not null))
        or ${table.source_type} = 'manual'`,
    ),
    check(
      "finance_cost_entry_usage_model_check",
      sql`${table.source_type} <> 'usage'
        or (${table.category} = 'model_cost' and ${table.provider} is not null and ${table.model} is not null)`,
    ),
    check("finance_cost_entry_payload_hash_check", sql`length(${table.payload_hash}) = 64`),
  ],
)

export const FinanceCostValuationTable = sqliteTable(
  "finance_cost_valuation",
  {
    id: id(),
    cost_entry_id: ulid("cost_entry_id").notNull(),
    fx_rate_id: ulid("fx_rate_id").notNull(),
    method: text("method", { enum: FinanceCostValuationMethods }).notNull(),
    version: integer("version").notNull(),
    amount_mnt_micros: integer("amount_mnt_micros").notNull(),
    idempotency_key: text("idempotency_key", { length: 255 }).notNull(),
    payload_hash: text("payload_hash", { length: 64 }).notNull(),
    time_created: utc("time_created").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("finance_cost_valuation_idempotency_key").on(table.idempotency_key),
    uniqueIndex("finance_cost_valuation_entry_version").on(table.cost_entry_id, table.version),
    index("finance_cost_valuation_entry_created").on(table.cost_entry_id, table.time_created),
    index("finance_cost_valuation_fx_rate_id").on(table.fx_rate_id),
    check(
      "finance_cost_valuation_method_check",
      sql`${table.method} in ('historical_spot', 'provider_settlement', 'manual')`,
    ),
    check("finance_cost_valuation_version_check", sql`${table.version} > 0`),
    check("finance_cost_valuation_amount_check", sql`${table.amount_mnt_micros} > 0`),
    check("finance_cost_valuation_identity_check", sql`length(trim(${table.idempotency_key})) between 1 and 255`),
    check("finance_cost_valuation_payload_hash_check", sql`length(${table.payload_hash}) = 64`),
  ],
)

export const FinancePaymentSettlementTable = sqliteTable(
  "finance_payment_settlement",
  {
    id: id(),
    workspace_id: ulid("workspace_id").notNull(),
    payment_invoice_id: ulid("payment_invoice_id").notNull(),
    payment_event_id: ulid("payment_event_id"),
    provider: text("provider", { enum: PaymentProviders }).notNull(),
    merchant_account_id: text("merchant_account_id", { length: 255 }).notNull(),
    external_settlement_id: text("external_settlement_id", { length: 255 }).notNull(),
    kind: text("kind", { enum: FinancePaymentSettlementKinds }).notNull(),
    gross_amount_mnt: integer("gross_amount_mnt").notNull(),
    fee_amount_mnt: integer("fee_amount_mnt").notNull(),
    tax_amount_mnt: integer("tax_amount_mnt").notNull(),
    net_amount_mnt: integer("net_amount_mnt").notNull(),
    currency: text("currency", { enum: ["MNT"] })
      .notNull()
      .default("MNT"),
    idempotency_key: text("idempotency_key", { length: 255 }).notNull(),
    payload_hash: text("payload_hash", { length: 64 }).notNull(),
    time_effective: utc("time_effective").notNull(),
    time_created: utc("time_created").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("finance_payment_settlement_idempotency_key").on(table.idempotency_key),
    uniqueIndex("finance_payment_settlement_provider_external").on(
      table.provider,
      table.merchant_account_id,
      table.external_settlement_id,
    ),
    index("finance_payment_settlement_invoice_time").on(table.payment_invoice_id, table.time_effective),
    index("finance_payment_settlement_workspace_time").on(table.workspace_id, table.time_effective),
    index("finance_payment_settlement_event_id").on(table.payment_event_id),
    check("finance_payment_settlement_provider_check", sql`${table.provider} in ('qpay', 'bonum')`),
    check("finance_payment_settlement_kind_check", sql`${table.kind} in ('payment', 'refund', 'adjustment')`),
    check(
      "finance_payment_settlement_gross_sign_check",
      sql`(${table.kind} = 'payment' and ${table.gross_amount_mnt} > 0)
        or (${table.kind} = 'refund' and ${table.gross_amount_mnt} < 0)
        or (${table.kind} = 'adjustment' and ${table.gross_amount_mnt} <> 0)`,
    ),
    check(
      "finance_payment_settlement_balance_check",
      sql`${table.net_amount_mnt} = ${table.gross_amount_mnt} - ${table.fee_amount_mnt} - ${table.tax_amount_mnt}`,
    ),
    check("finance_payment_settlement_currency_check", sql`${table.currency} = 'MNT'`),
    check(
      "finance_payment_settlement_identity_check",
      sql`length(trim(${table.merchant_account_id})) between 1 and 255
        and length(trim(${table.external_settlement_id})) between 1 and 255
        and length(trim(${table.idempotency_key})) between 1 and 255`,
    ),
    check("finance_payment_settlement_payload_hash_check", sql`length(${table.payload_hash}) = 64`),
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
