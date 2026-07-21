import { and, asc, Database, desc, eq, gt, inArray, isNull, lte } from "./drizzle"
import { Identifier } from "./identifier"
import { recordPaymentInvoiceWithDb } from "./payment-ledger"
import {
  PaymentCheckoutTable,
  PaymentEventTypes,
  PaymentInvoiceTable,
  PlanSubscriptionTable,
} from "./schema/billing.sql"
import {
  PaymentPlanCatalogSchema,
  SubscriptionBillingOverviewSchema,
  SubscriptionCheckoutRequestSchema,
  SubscriptionCheckoutResultSchema,
  type PaymentPlanCatalog,
  type SubscriptionBillingOverview,
  type SubscriptionCheckoutRequest,
  type SubscriptionCheckoutResult,
} from "./payment-checkout-contract"
import {
  PaymentInvoiceCheckoutSchema,
  PaymentProviderResponseError,
  type PaymentProviderAdapter,
} from "./payment-provider"
import { UserTable } from "./schema/user.sql"
import { z } from "zod"

const OPEN_CHECKOUT_STATUSES = ["creating", "unknown", "ready", "pending"] as const
const DEFAULT_INVOICE_TTL_MS = 15 * 60 * 1_000
const PAYMENT_EXPIRY_GRACE_MS = 5 * 60 * 1_000

const internalIdentifier = z.string().trim().min(5).max(30)

export {
  PaymentPlanCatalogSchema,
  SubscriptionBillingOverviewSchema,
  SubscriptionCheckoutRequestSchema,
  SubscriptionCheckoutResultSchema,
  type PaymentPlanCatalog,
  type SubscriptionBillingOverview,
  type SubscriptionCheckoutRequest,
  type SubscriptionCheckoutResult,
} from "./payment-checkout-contract"

export class PaymentCheckoutConflictError extends Error {
  constructor(
    readonly state: "active_subscription" | "open_checkout" | "request_in_progress" | "request_closed",
    readonly invoiceID?: string,
  ) {
    super(`Payment checkout conflict: ${state}`)
    this.name = "PaymentCheckoutConflictError"
  }
}

export class PaymentCheckoutCreationError extends Error {
  constructor(
    readonly state: "failed" | "unknown",
    readonly code: string,
  ) {
    super(`Payment checkout creation ${state}: ${code}`)
    this.name = "PaymentCheckoutCreationError"
  }
}

export class PaymentCheckoutAuthorizationError extends Error {
  constructor() {
    super("Payment checkout requires an active workspace administrator")
    this.name = "PaymentCheckoutAuthorizationError"
  }
}

type Transaction = <T>(callback: (db: Database.TxOrDb) => Promise<T>) => Promise<T>

export async function createSubscriptionCheckout(
  input: SubscriptionCheckoutRequest,
  dependencies: {
    adapter: PaymentProviderAdapter
    catalog: PaymentPlanCatalog
    transaction?: Transaction
    now?: () => number
    invoiceTtlMs?: number
  },
): Promise<SubscriptionCheckoutResult> {
  const request = SubscriptionCheckoutRequestSchema.parse(input)
  const catalog = PaymentPlanCatalogSchema.parse(dependencies.catalog)
  if (request.provider !== dependencies.adapter.provider) throw new TypeError("Payment provider does not match request")

  const now = dependencies.now ?? Date.now
  const createdAt = now()
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError("Payment checkout timestamp is invalid")
  const invoiceTtlMs = dependencies.invoiceTtlMs ?? DEFAULT_INVOICE_TTL_MS
  if (!Number.isSafeInteger(invoiceTtlMs) || invoiceTtlMs < 60_000 || invoiceTtlMs > 86_400_000) {
    throw new TypeError("Payment checkout expiry is invalid")
  }
  const expiresAt = createdAt + invoiceTtlMs
  if (!Number.isSafeInteger(expiresAt)) throw new TypeError("Payment checkout expiry is invalid")

  const transaction = dependencies.transaction ?? ((callback) => Database.transaction(callback))
  const plan = catalog[request.plan]
  const invoiceID = Identifier.create("paymentInvoice")
  const reservation = await transaction((db) =>
    reserveSubscriptionCheckoutWithDb(db, {
      ...request,
      invoiceID,
      merchantAccountID: dependencies.adapter.merchantAccountID,
      amount: plan.amount,
      createdAt,
      expiresAt,
    }),
  )

  if (reservation.kind === "replay") return checkoutResult(reservation.invoice)
  if (reservation.kind === "conflict") {
    throw new PaymentCheckoutConflictError("open_checkout", reservation.invoice.id)
  }
  if (reservation.kind === "closed") {
    throw new PaymentCheckoutConflictError("request_closed", reservation.invoice.id)
  }
  if (reservation.kind === "in_progress") {
    throw new PaymentCheckoutConflictError("request_in_progress", reservation.invoice.id)
  }

  let checkout: z.output<typeof PaymentInvoiceCheckoutSchema>
  try {
    checkout = await dependencies.adapter.createInvoice({
      reference: reservation.invoice.id,
      customerReference: request.accountID,
      description: `MongolGPT ${plan.label} сарын эрх`,
      amount: plan.amount,
      currency: "MNT",
      expiresAt,
    })
  } catch (error) {
    const failure = classifyCreationFailure(error)
    await transaction((db) =>
      markCheckoutCreationWithDb(db, reservation.invoice.id, failure.state, failure.code, createdAt),
    ).catch(() => undefined)
    throw new PaymentCheckoutCreationError(failure.state, failure.code)
  }

  const readyAt = now()
  if (!Number.isSafeInteger(readyAt) || readyAt < createdAt) {
    await transaction((db) =>
      markCheckoutCreationWithDb(db, reservation.invoice.id, "unknown", "persistence_failed", createdAt),
    ).catch(() => undefined)
    throw new PaymentCheckoutCreationError("unknown", "persistence_failed")
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completed = await transaction((db) =>
        completeSubscriptionCheckoutWithDb(db, reservation.invoice.id, checkout, readyAt),
      )
      return checkoutResult(completed)
    } catch {
      if (attempt === 0) continue
    }
  }
  await transaction((db) =>
    markCheckoutCreationWithDb(db, reservation.invoice.id, "unknown", "persistence_failed", createdAt),
  ).catch(() => undefined)
  throw new PaymentCheckoutCreationError("unknown", "persistence_failed")
}

export async function getSubscriptionBillingOverviewWithDb(
  db: Database.TxOrDb,
  workspaceID: string,
  now = Date.now(),
): Promise<SubscriptionBillingOverview> {
  const workspace = internalIdentifier.regex(/^wrk_/).parse(workspaceID)
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Payment overview timestamp is invalid")

  const [subscription, checkout] = await Promise.all([
    db
      .select({
        id: PlanSubscriptionTable.id,
        plan: PlanSubscriptionTable.plan,
        status: PlanSubscriptionTable.status,
        periodStart: PlanSubscriptionTable.timePeriodStart,
        periodEnd: PlanSubscriptionTable.timePeriodEnd,
      })
      .from(PlanSubscriptionTable)
      .where(
        and(
          eq(PlanSubscriptionTable.workspaceID, workspace),
          eq(PlanSubscriptionTable.status, "active"),
          isNull(PlanSubscriptionTable.timeDeleted),
          gt(PlanSubscriptionTable.timePeriodEnd, new Date(now)),
        ),
      )
      .orderBy(desc(PlanSubscriptionTable.timePeriodEnd))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({
        invoiceID: PaymentCheckoutTable.id,
        status: PaymentCheckoutTable.status,
        provider: PaymentCheckoutTable.provider,
        plan: PaymentCheckoutTable.plan,
        amount: PaymentCheckoutTable.amount,
        currency: PaymentCheckoutTable.currency,
        createdAt: PaymentCheckoutTable.timeCreated,
        expiresAt: PaymentCheckoutTable.time_expires,
        checkout: PaymentCheckoutTable.checkout,
      })
      .from(PaymentCheckoutTable)
      .where(
        and(
          eq(PaymentCheckoutTable.workspace_id, workspace),
          eq(PaymentCheckoutTable.purpose, "subscription"),
          isNull(PaymentCheckoutTable.timeDeleted),
        ),
      )
      .orderBy(desc(PaymentCheckoutTable.timeCreated))
      .limit(1)
      .then((rows) => rows[0]),
  ])

  return SubscriptionBillingOverviewSchema.parse({
    subscription: subscription
      ? {
          ...subscription,
          periodStart: subscription.periodStart.getTime(),
          periodEnd: subscription.periodEnd.getTime(),
        }
      : null,
    checkout: checkout
      ? {
          ...checkout,
          plan: checkout.plan,
          createdAt: checkout.createdAt.getTime(),
          expiresAt: checkout.expiresAt.getTime(),
        }
      : null,
  })
}

export function getSubscriptionBillingOverview(workspaceID: string, now = Date.now()) {
  return Database.use((db) => getSubscriptionBillingOverviewWithDb(db, workspaceID, now))
}

export async function expireOpenPaymentCheckoutsWithDb(db: Database.TxOrDb, now = Date.now(), limit = 100) {
  validateSweepInput(now, limit)
  const cutoff = new Date(Math.max(0, now - PAYMENT_EXPIRY_GRACE_MS))
  const rows = await db
    .select({ id: PaymentCheckoutTable.id, status: PaymentCheckoutTable.status })
    .from(PaymentCheckoutTable)
    .where(
      and(
        inArray(PaymentCheckoutTable.status, OPEN_CHECKOUT_STATUSES),
        isNull(PaymentCheckoutTable.timeDeleted),
        lte(PaymentCheckoutTable.time_expires, cutoff),
      ),
    )
    .orderBy(asc(PaymentCheckoutTable.time_expires))
    .limit(limit)

  let applied = 0
  for (const row of rows) {
    const changed = await db
      .update(PaymentCheckoutTable)
      .set({ status: "expired", time_expired: new Date(now) })
      .where(and(eq(PaymentCheckoutTable.id, row.id), eq(PaymentCheckoutTable.status, row.status)))
      .returning({ id: PaymentCheckoutTable.id })
    if (changed.length > 0) applied++
    if (changed.length > 0) await expireLedgerInvoiceWithDb(db, row.id, now)
  }
  return applied
}

export function expireOpenPaymentCheckouts(now = Date.now(), limit = 100) {
  return Database.transaction((db) => expireOpenPaymentCheckoutsWithDb(db, now, limit))
}

export async function syncPaymentCheckoutStatusWithDb(
  db: Database.TxOrDb,
  invoiceID: string,
  status: (typeof PaymentEventTypes)[number],
  occurredAt: number,
) {
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new TypeError("Payment event timestamp is invalid")
  const current = await db
    .select({ status: PaymentCheckoutTable.status })
    .from(PaymentCheckoutTable)
    .where(and(eq(PaymentCheckoutTable.id, invoiceID), isNull(PaymentCheckoutTable.timeDeleted)))
    .limit(1)
    .then((rows) => rows[0])
  if (!current) return false

  const allowed =
    status === "refunded"
      ? current.status === "paid"
      : current.status === "ready" || current.status === "pending" || current.status === status
  if (!allowed) throw new Error("Payment checkout status does not match verified event")

  const timestamp = new Date(occurredAt)
  const changed = await db
    .update(PaymentCheckoutTable)
    .set({
      status,
      ...(status === "paid" ? { time_paid: timestamp } : {}),
      ...(status === "failed" ? { time_failed: timestamp } : {}),
      ...(status === "expired" ? { time_expired: timestamp } : {}),
      ...(status === "cancelled" ? { time_cancelled: timestamp } : {}),
      ...(status === "refunded" ? { time_refunded: timestamp } : {}),
    })
    .where(and(eq(PaymentCheckoutTable.id, invoiceID), eq(PaymentCheckoutTable.status, current.status)))
    .returning({ id: PaymentCheckoutTable.id })
  if (changed.length !== 1) throw new Error("Payment checkout changed concurrently")
  return true
}

async function reserveSubscriptionCheckoutWithDb(
  db: Database.TxOrDb,
  input: z.output<typeof SubscriptionCheckoutRequestSchema> & {
    invoiceID: string
    merchantAccountID: string
    amount: number
    createdAt: number
    expiresAt: number
  },
) {
  const administrator = await db
    .select({ id: UserTable.id })
    .from(UserTable)
    .where(
      and(
        eq(UserTable.workspaceID, input.workspaceID),
        eq(UserTable.accountID, input.accountID),
        eq(UserTable.role, "admin"),
        isNull(UserTable.timeDeleted),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (!administrator) throw new PaymentCheckoutAuthorizationError()

  await expireWorkspaceOpenInvoices(db, input.workspaceID, input.createdAt)
  const active = await db
    .select({ id: PlanSubscriptionTable.id })
    .from(PlanSubscriptionTable)
    .where(
      and(
        eq(PlanSubscriptionTable.workspaceID, input.workspaceID),
        eq(PlanSubscriptionTable.status, "active"),
        isNull(PlanSubscriptionTable.timeDeleted),
        gt(PlanSubscriptionTable.timePeriodEnd, new Date(input.createdAt)),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (active) throw new PaymentCheckoutConflictError("active_subscription")

  const inserted = await db
    .insert(PaymentCheckoutTable)
    .values({
      id: input.invoiceID,
      workspace_id: input.workspaceID,
      account_id: input.accountID,
      request_key: input.requestKey,
      provider: input.provider,
      merchant_account_id: input.merchantAccountID,
      purpose: "subscription",
      plan: input.plan,
      amount: input.amount,
      currency: "MNT",
      status: "creating",
      time_expires: new Date(input.expiresAt),
      timeCreated: new Date(input.createdAt),
    })
    .onConflictDoNothing()

  if (resultChanges(inserted) === 1) {
    return { kind: "reserved" as const, invoice: await requireInvoice(db, input.invoiceID) }
  }

  const requestReplay = await db
    .select()
    .from(PaymentCheckoutTable)
    .where(
      and(
        eq(PaymentCheckoutTable.workspace_id, input.workspaceID),
        eq(PaymentCheckoutTable.request_key, input.requestKey),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (requestReplay) {
    assertCheckoutReplay(requestReplay, input)
    if (requestReplay.status === "ready" && requestReplay.checkout) {
      return { kind: "replay" as const, invoice: requestReplay }
    }
    if (requestReplay.status === "creating" || requestReplay.status === "unknown") {
      return { kind: "in_progress" as const, invoice: requestReplay }
    }
    return { kind: "closed" as const, invoice: requestReplay }
  }

  const open = await db
    .select()
    .from(PaymentCheckoutTable)
    .where(
      and(
        eq(PaymentCheckoutTable.workspace_id, input.workspaceID),
        eq(PaymentCheckoutTable.purpose, "subscription"),
        inArray(PaymentCheckoutTable.status, OPEN_CHECKOUT_STATUSES),
        isNull(PaymentCheckoutTable.timeDeleted),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (open) return { kind: "conflict" as const, invoice: open }
  throw new Error("Payment checkout reservation failed without a conflicting invoice")
}

async function completeSubscriptionCheckoutWithDb(
  db: Database.TxOrDb,
  invoiceID: string,
  input: z.input<typeof PaymentInvoiceCheckoutSchema>,
  readyAt: number,
) {
  const checkout = PaymentInvoiceCheckoutSchema.parse(input)
  const intent = await requireInvoice(db, invoiceID)
  if (intent.status === "ready" && intent.checkout && paymentCheckoutEqual(intent.checkout, checkout)) return intent
  if (intent.status !== "creating") throw new Error("Payment checkout is no longer being created")
  if (checkout.provider !== intent.provider || checkout.merchantAccountID !== intent.merchant_account_id) {
    throw new Error("Payment checkout provider binding does not match reservation")
  }

  await recordPaymentInvoiceWithDb(db, {
    id: intent.id,
    workspaceID: intent.workspace_id,
    provider: intent.provider,
    merchantAccountID: intent.merchant_account_id,
    externalInvoiceID: checkout.externalInvoiceID,
    purpose: intent.purpose,
    plan: intent.plan ?? undefined,
    amount: intent.amount,
    currency: intent.currency,
    expiresAt: intent.time_expires.getTime(),
  })

  const changed = await db
    .update(PaymentCheckoutTable)
    .set({
      external_invoice_id: checkout.externalInvoiceID,
      checkout,
      status: "ready",
      creation_error_code: null,
      time_ready: new Date(readyAt),
    })
    .where(and(eq(PaymentCheckoutTable.id, intent.id), eq(PaymentCheckoutTable.status, "creating")))
    .returning({ id: PaymentCheckoutTable.id })
  if (changed.length !== 1) throw new Error("Payment checkout changed concurrently")
  return requireInvoice(db, intent.id)
}

function paymentCheckoutEqual(
  left: z.output<typeof PaymentInvoiceCheckoutSchema>,
  right: z.output<typeof PaymentInvoiceCheckoutSchema>,
) {
  return (
    left.provider === right.provider &&
    left.merchantAccountID === right.merchantAccountID &&
    left.externalInvoiceID === right.externalInvoiceID &&
    left.qrText === right.qrText &&
    left.qrImage === right.qrImage &&
    left.checkoutURL === right.checkoutURL &&
    left.deepLinks.length === right.deepLinks.length &&
    left.deepLinks.every(
      (link, index) =>
        link.name === right.deepLinks[index]?.name &&
        link.description === right.deepLinks[index]?.description &&
        link.link === right.deepLinks[index]?.link,
    )
  )
}

async function markCheckoutCreationWithDb(
  db: Database.TxOrDb,
  invoiceID: string,
  state: "failed" | "unknown",
  code: string,
  now: number,
) {
  await db
    .update(PaymentCheckoutTable)
    .set({ status: state, creation_error_code: code, ...(state === "failed" ? { time_failed: new Date(now) } : {}) })
    .where(and(eq(PaymentCheckoutTable.id, invoiceID), eq(PaymentCheckoutTable.status, "creating")))
}

async function expireWorkspaceOpenInvoices(db: Database.TxOrDb, workspaceID: string, now: number) {
  const expired = await db
    .update(PaymentCheckoutTable)
    .set({ status: "expired", time_expired: new Date(now) })
    .where(
      and(
        eq(PaymentCheckoutTable.workspace_id, workspaceID),
        eq(PaymentCheckoutTable.purpose, "subscription"),
        inArray(PaymentCheckoutTable.status, OPEN_CHECKOUT_STATUSES),
        isNull(PaymentCheckoutTable.timeDeleted),
        lte(PaymentCheckoutTable.time_expires, new Date(Math.max(0, now - PAYMENT_EXPIRY_GRACE_MS))),
      ),
    )
    .returning({ id: PaymentCheckoutTable.id })
  for (const row of expired) await expireLedgerInvoiceWithDb(db, row.id, now)
}

async function expireLedgerInvoiceWithDb(db: Database.TxOrDb, invoiceID: string, now: number) {
  await db
    .update(PaymentInvoiceTable)
    .set({ status: "expired", time_expired: new Date(now) })
    .where(and(eq(PaymentInvoiceTable.id, invoiceID), inArray(PaymentInvoiceTable.status, ["created", "pending"])))
}

function checkoutResult(invoice: typeof PaymentCheckoutTable.$inferSelect): SubscriptionCheckoutResult {
  if (!invoice.plan || !invoice.time_expires || !invoice.checkout) {
    throw new Error("Payment checkout record is incomplete")
  }
  return SubscriptionCheckoutResultSchema.parse({
    invoiceID: invoice.id,
    status: invoice.status,
    provider: invoice.provider,
    plan: invoice.plan,
    amount: invoice.amount,
    currency: invoice.currency,
    expiresAt: invoice.time_expires.getTime(),
    checkout: invoice.checkout,
  })
}

function assertCheckoutReplay(
  stored: typeof PaymentCheckoutTable.$inferSelect,
  replay: z.output<typeof SubscriptionCheckoutRequestSchema> & { merchantAccountID: string; amount: number },
) {
  if (
    stored.account_id !== replay.accountID ||
    stored.provider !== replay.provider ||
    stored.merchant_account_id !== replay.merchantAccountID ||
    stored.purpose !== "subscription" ||
    stored.plan !== replay.plan ||
    stored.amount !== replay.amount ||
    stored.currency !== "MNT"
  ) {
    throw new Error("Payment checkout request replay conflicts with the stored invoice")
  }
}

function classifyCreationFailure(error: unknown) {
  if (
    error instanceof PaymentProviderResponseError &&
    !error.retryable &&
    [400, 401, 403, 404, 422].includes(error.status)
  ) {
    return { state: "failed" as const, code: `provider_${error.status}` }
  }
  if (error instanceof PaymentProviderResponseError) {
    return { state: "unknown" as const, code: `provider_${error.status}` }
  }
  return { state: "unknown" as const, code: "provider_uncertain" }
}

function validateSweepInput(now: number, limit: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Payment expiration timestamp is invalid")
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError("Payment expiration limit is invalid")
  }
}

async function requireInvoice(db: Database.TxOrDb, invoiceID: string) {
  const invoice = await db
    .select()
    .from(PaymentCheckoutTable)
    .where(eq(PaymentCheckoutTable.id, invoiceID))
    .limit(1)
    .then((rows) => rows[0])
  if (!invoice) throw new Error("Payment checkout invoice disappeared")
  return invoice
}

function resultChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0
  if ("meta" in result && result.meta && typeof result.meta === "object" && "changes" in result.meta) {
    return Number(result.meta.changes ?? 0)
  }
  if ("changes" in result) return Number(result.changes ?? 0)
  return 0
}
