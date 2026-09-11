import { and, asc, Database, desc, eq, exists, gt, inArray, isNull, lte, notExists, sql } from "./drizzle"
import { Identifier } from "./identifier"
import {
  PaymentCheckoutTable,
  PaymentCancellationTable,
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
    super(`Төлбөрийн хүсэлтэд зөрчил гарлаа: ${state}`)
    this.name = "PaymentCheckoutConflictError"
  }
}

export class PaymentCheckoutCreationError extends Error {
  constructor(
    readonly state: "failed" | "unknown",
    readonly code: string,
  ) {
    super(`Төлбөрийн хүсэлт үүсгэх үйлдэл ${state} төлөвтэй байна: ${code}`)
    this.name = "PaymentCheckoutCreationError"
  }
}

export class PaymentCheckoutAuthorizationError extends Error {
  constructor() {
    super("Төлбөрийн хүсэлт үүсгэхэд ажлын талбарын идэвхтэй администратор шаардлагатай")
    this.name = "PaymentCheckoutAuthorizationError"
  }
}

export async function createSubscriptionCheckout(
  input: SubscriptionCheckoutRequest,
  dependencies: {
    adapter: PaymentProviderAdapter
    catalog: PaymentPlanCatalog
    batch?: typeof Database.batch
    now?: () => number
    invoiceTtlMs?: number
  },
): Promise<SubscriptionCheckoutResult> {
  const request = SubscriptionCheckoutRequestSchema.parse(input)
  const catalog = PaymentPlanCatalogSchema.parse(dependencies.catalog)
  if (request.provider !== dependencies.adapter.provider)
    throw new TypeError("Төлбөрийн нийлүүлэгч хүсэлттэй таарахгүй байна")

  const now = dependencies.now ?? Date.now
  const createdAt = now()
  if (!Number.isSafeInteger(createdAt) || createdAt < 0)
    throw new TypeError("Төлбөрийн хүсэлтийн цагийн тэмдэг буруу байна")
  const invoiceTtlMs = dependencies.invoiceTtlMs ?? DEFAULT_INVOICE_TTL_MS
  if (!Number.isSafeInteger(invoiceTtlMs) || invoiceTtlMs < 60_000 || invoiceTtlMs > 86_400_000) {
    throw new TypeError("Төлбөрийн хүсэлтийн дуусах хугацаа буруу байна")
  }
  const expiresAt = createdAt + invoiceTtlMs
  if (!Number.isSafeInteger(expiresAt)) throw new TypeError("Төлбөрийн хүсэлтийн дуусах хугацаа буруу байна")

  const batch = dependencies.batch ?? Database.batch
  const plan = catalog[request.plan]
  const invoiceID = Identifier.create("paymentInvoice")
  const reservation = await reserveSubscriptionCheckout(batch, {
    ...request,
    invoiceID,
    merchantAccountID: dependencies.adapter.merchantAccountID,
    amount: plan.amount,
    createdAt,
    expiresAt,
  })

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
    await markCheckoutCreation(batch, reservation.invoice.id, failure.state, failure.code, createdAt).catch(
      () => undefined,
    )
    throw new PaymentCheckoutCreationError(failure.state, failure.code)
  }

  const readyAt = now()
  if (!Number.isSafeInteger(readyAt) || readyAt < createdAt) {
    await markCheckoutCreation(batch, reservation.invoice.id, "unknown", "persistence_failed", createdAt).catch(
      () => undefined,
    )
    throw new PaymentCheckoutCreationError("unknown", "persistence_failed")
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completed = await completeSubscriptionCheckout(batch, reservation.invoice.id, checkout, readyAt)
      return checkoutResult(completed)
    } catch {
      if (attempt === 0) continue
    }
  }
  await markCheckoutCreation(batch, reservation.invoice.id, "unknown", "persistence_failed", createdAt).catch(
    () => undefined,
  )
  throw new PaymentCheckoutCreationError("unknown", "persistence_failed")
}

export async function getSubscriptionBillingOverviewWithDb(
  db: Database.TxOrDb,
  workspaceID: string,
  now = Date.now(),
): Promise<SubscriptionBillingOverview> {
  const workspace = internalIdentifier.regex(/^wrk_/).parse(workspaceID)
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Төлбөрийн тоймын цагийн тэмдэг буруу байна")

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
          lte(PlanSubscriptionTable.timePeriodStart, new Date(now)),
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
        cancellationStatus: PaymentCancellationTable.status,
        cancellationErrorCode: PaymentCancellationTable.error_code,
      })
      .from(PaymentCheckoutTable)
      .leftJoin(PaymentCancellationTable, eq(PaymentCancellationTable.invoice_id, PaymentCheckoutTable.id))
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
  const checkoutOverview = checkout
    ? (() => {
        const { cancellationStatus, cancellationErrorCode, ...value } = checkout
        const settled = value.status === "paid" || value.status === "refunded"
        return {
          ...value,
          createdAt: value.createdAt.getTime(),
          expiresAt: value.expiresAt.getTime(),
          cancellation:
            !settled && cancellationStatus ? { status: cancellationStatus, errorCode: cancellationErrorCode } : null,
        }
      })()
    : null

  return SubscriptionBillingOverviewSchema.parse({
    subscription: subscription
      ? {
          ...subscription,
          periodStart: subscription.periodStart.getTime(),
          periodEnd: subscription.periodEnd.getTime(),
        }
      : null,
    checkout: checkoutOverview,
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

export async function expireOpenPaymentCheckouts(
  now = Date.now(),
  limit = 100,
  dependencies: { batch?: typeof Database.batch } = {},
) {
  validateSweepInput(now, limit)
  const [, expired] = await (dependencies.batch ?? Database.batch)((db) => {
    const eligible = db
      .select({ id: PaymentCheckoutTable.id })
      .from(PaymentCheckoutTable)
      .where(
        and(
          inArray(PaymentCheckoutTable.status, OPEN_CHECKOUT_STATUSES),
          isNull(PaymentCheckoutTable.timeDeleted),
          lte(PaymentCheckoutTable.time_expires, new Date(Math.max(0, now - PAYMENT_EXPIRY_GRACE_MS))),
        ),
      )
      .orderBy(asc(PaymentCheckoutTable.time_expires), asc(PaymentCheckoutTable.id))
      .limit(limit)
    // The ledger update leaves eligibility unchanged, so both statements affect the same bounded set.
    return [
      db
        .update(PaymentInvoiceTable)
        .set({ status: "expired", time_expired: new Date(now) })
        .where(
          and(
            inArray(PaymentInvoiceTable.id, eligible),
            inArray(PaymentInvoiceTable.status, ["created", "pending"]),
            isNull(PaymentInvoiceTable.timeDeleted),
          ),
        ),
      db
        .update(PaymentCheckoutTable)
        .set({ status: "expired", time_expired: new Date(now) })
        .where(inArray(PaymentCheckoutTable.id, eligible))
        .returning({ id: PaymentCheckoutTable.id }),
    ] as const
  })
  return expired.length
}

export async function syncPaymentCheckoutStatusWithDb(
  db: Database.TxOrDb,
  invoiceID: string,
  status: (typeof PaymentEventTypes)[number],
  occurredAt: number,
) {
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0)
    throw new TypeError("Төлбөрийн үйл явдлын цагийн тэмдэг буруу байна")
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
      : status === "paid"
        ? ["ready", "pending", "failed", "expired", "cancelled", "paid"].includes(current.status)
        : current.status === "ready" || current.status === "pending" || current.status === status
  if (!allowed) throw new Error("Төлбөрийн хүсэлтийн төлөв баталгаажсан үйл явдалтай таарахгүй байна")

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
  if (changed.length !== 1) throw new Error("Төлбөрийн хүсэлтийн мэдээлэл зэрэг өөрчлөгдсөн байна")
  return true
}

async function reserveSubscriptionCheckout(
  batch: typeof Database.batch,
  input: z.output<typeof SubscriptionCheckoutRequestSchema> & {
    invoiceID: string
    merchantAccountID: string
    amount: number
    createdAt: number
    expiresAt: number
  },
) {
  // Policy checks, expiry, reservation and replay reads share one D1 transaction.
  const [administrators, subscriptions, , , inserted, replays, open] = await batch((db) => {
    const administrator = db
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
    const active = db
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
    const allowed = and(exists(administrator), notExists(active))
    const expired = and(
      eq(PaymentCheckoutTable.workspace_id, input.workspaceID),
      eq(PaymentCheckoutTable.purpose, "subscription"),
      inArray(PaymentCheckoutTable.status, OPEN_CHECKOUT_STATUSES),
      isNull(PaymentCheckoutTable.timeDeleted),
      lte(PaymentCheckoutTable.time_expires, new Date(Math.max(0, input.createdAt - PAYMENT_EXPIRY_GRACE_MS))),
    )
    return [
      administrator,
      active,
      db
        .update(PaymentInvoiceTable)
        .set({ status: "expired", time_expired: new Date(input.createdAt) })
        .where(
          and(
            allowed,
            inArray(PaymentInvoiceTable.status, ["created", "pending"]),
            isNull(PaymentInvoiceTable.timeDeleted),
            inArray(
              PaymentInvoiceTable.id,
              db.select({ id: PaymentCheckoutTable.id }).from(PaymentCheckoutTable).where(expired),
            ),
          ),
        ),
      db
        .update(PaymentCheckoutTable)
        .set({ status: "expired", time_expired: new Date(input.createdAt) })
        .where(and(allowed, expired)),
      db
        .insert(PaymentCheckoutTable)
        .select(
          db
            .select({
              id: sql<string>`${input.invoiceID}`.as("id"),
              workspace_id: sql<string>`${input.workspaceID}`.as("workspace_id"),
              account_id: sql<string>`${input.accountID}`.as("account_id"),
              request_key: sql<string>`${input.requestKey}`.as("request_key"),
              provider: sql<typeof input.provider>`${input.provider}`.as("provider"),
              merchant_account_id: sql<string>`${input.merchantAccountID}`.as("merchant_account_id"),
              external_invoice_id: sql<null>`null`.as("external_invoice_id"),
              purpose: sql<"subscription">`'subscription'`.as("purpose"),
              plan: sql<typeof input.plan>`${input.plan}`.as("plan"),
              amount: sql<number>`${input.amount}`.as("amount"),
              currency: sql<"MNT">`'MNT'`.as("currency"),
              checkout: sql<null>`null`.as("checkout"),
              creation_error_code: sql<null>`null`.as("creation_error_code"),
              status: sql<"creating">`'creating'`.as("status"),
              time_expires: sql<Date>`${input.expiresAt}`.as("time_expires"),
              time_ready: sql<null>`null`.as("time_ready"),
              time_failed: sql<null>`null`.as("time_failed"),
              time_expired: sql<null>`null`.as("time_expired"),
              time_cancelled: sql<null>`null`.as("time_cancelled"),
              time_paid: sql<null>`null`.as("time_paid"),
              time_refunded: sql<null>`null`.as("time_refunded"),
              timeCreated: sql<Date>`${input.createdAt}`.as("time_created"),
              timeUpdated: sql<Date>`${input.createdAt}`.as("time_updated"),
              timeDeleted: sql<null>`null`.as("time_deleted"),
            })
            .from(UserTable)
            .where(
              and(
                allowed,
                eq(UserTable.workspaceID, input.workspaceID),
                eq(UserTable.accountID, input.accountID),
                eq(UserTable.role, "admin"),
                isNull(UserTable.timeDeleted),
              ),
            )
            .limit(1),
        )
        .onConflictDoNothing()
        .returning(),
      db
        .select()
        .from(PaymentCheckoutTable)
        .where(
          and(
            eq(PaymentCheckoutTable.workspace_id, input.workspaceID),
            eq(PaymentCheckoutTable.request_key, input.requestKey),
          ),
        )
        .limit(1),
      db
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
        .limit(1),
    ] as const
  })
  if (!administrators[0]) throw new PaymentCheckoutAuthorizationError()
  if (subscriptions[0]) throw new PaymentCheckoutConflictError("active_subscription")
  if (inserted[0]) return { kind: "reserved" as const, invoice: inserted[0] }
  const requestReplay = replays[0]
  if (requestReplay) {
    assertCheckoutReplay(requestReplay, input)
    if (requestReplay.timeDeleted) return { kind: "closed" as const, invoice: requestReplay }
    if (requestReplay.status === "ready" && requestReplay.checkout) {
      return { kind: "replay" as const, invoice: requestReplay }
    }
    if (requestReplay.status === "creating" || requestReplay.status === "unknown") {
      return { kind: "in_progress" as const, invoice: requestReplay }
    }
    return { kind: "closed" as const, invoice: requestReplay }
  }

  if (open[0]) return { kind: "conflict" as const, invoice: open[0] }
  throw new Error("Зөрчилтэй нэхэмжлэх байхгүй боловч төлбөрийн хүсэлтийн нөөцлөлт амжилтгүй боллоо")
}

async function completeSubscriptionCheckout(
  batch: typeof Database.batch,
  invoiceID: string,
  input: z.input<typeof PaymentInvoiceCheckoutSchema>,
  readyAt: number,
) {
  const checkout = PaymentInvoiceCheckoutSchema.parse(input)
  const [, , rows] = await batch((db) => {
    const creating = and(
      eq(PaymentCheckoutTable.id, invoiceID),
      eq(PaymentCheckoutTable.status, "creating"),
      eq(PaymentCheckoutTable.provider, checkout.provider),
      eq(PaymentCheckoutTable.merchant_account_id, checkout.merchantAccountID),
      isNull(PaymentCheckoutTable.timeDeleted),
    )
    const ledger = db
      .select({ id: PaymentInvoiceTable.id })
      .from(PaymentInvoiceTable)
      .where(
        and(
          eq(PaymentInvoiceTable.id, PaymentCheckoutTable.id),
          eq(PaymentInvoiceTable.workspace_id, PaymentCheckoutTable.workspace_id),
          eq(PaymentInvoiceTable.provider, PaymentCheckoutTable.provider),
          eq(PaymentInvoiceTable.merchant_account_id, PaymentCheckoutTable.merchant_account_id),
          eq(PaymentInvoiceTable.external_invoice_id, checkout.externalInvoiceID),
          eq(PaymentInvoiceTable.purpose, PaymentCheckoutTable.purpose),
          eq(PaymentInvoiceTable.plan, PaymentCheckoutTable.plan),
          eq(PaymentInvoiceTable.amount, PaymentCheckoutTable.amount),
          eq(PaymentInvoiceTable.currency, PaymentCheckoutTable.currency),
          eq(PaymentInvoiceTable.time_expires, PaymentCheckoutTable.time_expires),
          eq(PaymentInvoiceTable.status, "created"),
          isNull(PaymentInvoiceTable.timeDeleted),
        ),
      )
    return [
      db
        .insert(PaymentInvoiceTable)
        .select(
          db
            .select({
              id: PaymentCheckoutTable.id,
              workspace_id: PaymentCheckoutTable.workspace_id,
              provider: PaymentCheckoutTable.provider,
              merchant_account_id: PaymentCheckoutTable.merchant_account_id,
              external_invoice_id: sql<string>`${checkout.externalInvoiceID}`.as("external_invoice_id"),
              external_payment_id: sql<null>`null`.as("external_payment_id"),
              purpose: PaymentCheckoutTable.purpose,
              plan: PaymentCheckoutTable.plan,
              amount: PaymentCheckoutTable.amount,
              currency: PaymentCheckoutTable.currency,
              status: sql<"created">`'created'`.as("status"),
              time_expires: PaymentCheckoutTable.time_expires,
              time_failed: sql<null>`null`.as("time_failed"),
              time_expired: sql<null>`null`.as("time_expired"),
              time_cancelled: sql<null>`null`.as("time_cancelled"),
              time_verified: sql<null>`null`.as("time_verified"),
              time_refunded: sql<null>`null`.as("time_refunded"),
              timeCreated: PaymentCheckoutTable.timeCreated,
              timeUpdated: sql<Date>`${readyAt}`.as("time_updated"),
              timeDeleted: sql<null>`null`.as("time_deleted"),
            })
            .from(PaymentCheckoutTable)
            .where(creating),
        )
        .onConflictDoNothing(),
      db
        .update(PaymentCheckoutTable)
        .set({
          external_invoice_id: checkout.externalInvoiceID,
          checkout,
          status: "ready",
          creation_error_code: null,
          time_ready: new Date(readyAt),
        })
        .where(and(creating, exists(ledger))),
      db.select().from(PaymentCheckoutTable).where(eq(PaymentCheckoutTable.id, invoiceID)).limit(1),
    ] as const
  })
  const intent = rows[0]
  if (
    intent?.status === "ready" &&
    !intent.timeDeleted &&
    intent.checkout &&
    paymentCheckoutEqual(intent.checkout, checkout)
  )
    return intent
  throw new Error("Төлбөрийн хүсэлт болон нэхэмжлэхийг хамтад нь баталгаажуулж чадсангүй")
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

async function markCheckoutCreation(
  batch: typeof Database.batch,
  invoiceID: string,
  state: "failed" | "unknown",
  code: string,
  now: number,
) {
  await batch((db) => [
    db
      .update(PaymentCheckoutTable)
      .set({ status: state, creation_error_code: code, ...(state === "failed" ? { time_failed: new Date(now) } : {}) })
      .where(
        and(
          eq(PaymentCheckoutTable.id, invoiceID),
          eq(PaymentCheckoutTable.status, "creating"),
          isNull(PaymentCheckoutTable.timeDeleted),
        ),
      ),
  ])
}

async function expireLedgerInvoiceWithDb(db: Database.TxOrDb, invoiceID: string, now: number) {
  await db
    .update(PaymentInvoiceTable)
    .set({ status: "expired", time_expired: new Date(now) })
    .where(and(eq(PaymentInvoiceTable.id, invoiceID), inArray(PaymentInvoiceTable.status, ["created", "pending"])))
}

function checkoutResult(invoice: typeof PaymentCheckoutTable.$inferSelect): SubscriptionCheckoutResult {
  if (!invoice.plan || !invoice.time_expires || !invoice.checkout) {
    throw new Error("Төлбөрийн хүсэлтийн бүртгэл бүрэн бус байна")
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
    throw new Error("Төлбөрийн хүсэлтийг дахин илгээхэд хадгалсан нэхэмжлэхтэй зөрчилдөж байна")
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
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Төлбөр дуусах хугацааны цагийн тэмдэг буруу байна")
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError("Төлбөр дуусах хугацааны хязгаар буруу байна")
  }
}
