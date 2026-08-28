import { and, Database, eq, isNull } from "./drizzle"
import {
  PaymentRefundStateSchema,
  PlatformAdminSubscriptionPaymentRefundRequestSchema,
  SubscriptionPaymentRefundResultSchema,
  type PlatformAdminSubscriptionPaymentRefundRequest,
  type SubscriptionPaymentRefundResult,
} from "./payment-refund-contract"
import {
  PaymentProviderResponseError,
  parseVerifiedPaymentEvent,
  sha256Hex,
  type PaymentRefundAdapter,
  type VerifiedPaymentEvent,
} from "./payment-provider"
import { PaymentCheckoutTable, PaymentInvoiceTable, PaymentProviders, PaymentRefundTable } from "./schema/billing.sql"

const REFUND_IN_PROGRESS_MS = 2 * 60 * 1_000

type Transaction = <T>(callback: (db: Database.TxOrDb) => Promise<T>) => Promise<T>
type Provider = (typeof PaymentProviders)[number]
type RefundAdapters = Partial<Record<Provider, PaymentRefundAdapter>>

export {
  PaymentRefundStateSchema,
  PlatformAdminSubscriptionPaymentRefundRequestSchema,
  SubscriptionPaymentRefundResultSchema,
  type PlatformAdminSubscriptionPaymentRefundRequest,
  type SubscriptionPaymentRefundResult,
} from "./payment-refund-contract"

export type SubscriptionRefundOutcome = {
  result: SubscriptionPaymentRefundResult
  event?: VerifiedPaymentEvent
}

export class PaymentRefundUnsupportedError extends Error {
  constructor(readonly provider: Provider) {
    super(`${provider} төлбөр буцаах үйлдлийг дэмжихгүй байна`)
    this.name = "PaymentRefundUnsupportedError"
  }
}

export class PaymentRefundUnavailableError extends Error {
  constructor(readonly provider: Provider) {
    super(`${provider} төлбөр буцаах үйлдлийг ашиглах боломжгүй байна`)
    this.name = "PaymentRefundUnavailableError"
  }
}

export class PaymentRefundConflictError extends Error {
  constructor(readonly state: "not_refundable" | "request_in_progress" | "result_unknown" | "request_failed") {
    super(`Төлбөр буцаахад зөрчил гарлаа: ${state}`)
    this.name = "PaymentRefundConflictError"
  }
}

export class PaymentRefundOperationError extends Error {
  constructor(
    readonly state: "failed" | "unknown",
    readonly code: string,
  ) {
    super(`Төлбөр буцаах ${state} төлөвтэй байна: ${code}`)
    this.name = "PaymentRefundOperationError"
  }
}

/**
 * Platform-admin refunds derive every money and ownership field from the stored ledger.
 * The operator identity and reason live in the immutable admin audit, not in provider input.
 */
export async function refundPlatformAdminSubscriptionPayment(
  input: PlatformAdminSubscriptionPaymentRefundRequest,
  dependencies: {
    adapters: RefundAdapters
    transaction?: Transaction
    now?: () => number
  },
): Promise<SubscriptionRefundOutcome> {
  const request = PlatformAdminSubscriptionPaymentRefundRequestSchema.parse(input)
  const now = dependencies.now ?? Date.now
  const requestedAt = now()
  validateTimestamp(requestedAt)
  const transaction = dependencies.transaction ?? ((callback) => Database.transaction(callback))
  const reservation = await transaction((db) =>
    reserveStoredRefundWithDb(db, request.invoiceID, request.requestKey, dependencies.adapters, requestedAt),
  )
  return finishRefundReservation(reservation, transaction, now, requestedAt)
}

async function finishRefundReservation(
  reservation: Awaited<ReturnType<typeof reserveStoredRefundWithDb>>,
  transaction: Transaction,
  now: () => number,
  requestedAt: number,
): Promise<SubscriptionRefundOutcome> {
  if (reservation.kind === "already_refunded") {
    return {
      result: SubscriptionPaymentRefundResultSchema.parse({
        invoiceID: reservation.invoice.id,
        provider: reservation.invoice.provider,
        status: "refunded",
      }),
    }
  }
  if (reservation.kind === "replay") return refundOutcome(reservation.refund)

  if (reservation.kind === "reconcile_unknown") {
    let receipt: Awaited<ReturnType<PaymentRefundAdapter["reconcileRefund"]>>
    try {
      receipt = await reservation.adapter.reconcileRefund(refundProviderRequest(reservation.refund))
    } catch {
      throw new PaymentRefundOperationError("unknown", "reconciliation_uncertain")
    }
    if (!receipt) throw new PaymentRefundConflictError("result_unknown")
    const reconciledAt = now()
    validateTimestamp(reconciledAt, requestedAt)
    try {
      const completed = await transaction((db) =>
        completeRefundWithDb(db, reservation.refund.invoice_id, receipt, reconciledAt, "unknown"),
      )
      return refundOutcome(completed)
    } catch {
      throw new PaymentRefundOperationError("unknown", "persistence_failed")
    }
  }

  let receipt: Awaited<ReturnType<PaymentRefundAdapter["refundPayment"]>>
  try {
    receipt = await reservation.adapter.refundPayment(refundProviderRequest(reservation.refund))
  } catch (error) {
    const failure = classifyRefundFailure(error)
    const failedAt = now()
    validateTimestamp(failedAt, requestedAt)
    await transaction((db) =>
      markRefundFailureWithDb(db, reservation.refund.invoice_id, failure.state, failure.code, failedAt),
    ).catch(() => undefined)
    throw new PaymentRefundOperationError(failure.state, failure.code)
  }

  const completedAt = now()
  validateTimestamp(completedAt, requestedAt)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completed = await transaction((db) =>
        completeRefundWithDb(db, reservation.refund.invoice_id, receipt, completedAt, "requested"),
      )
      return refundOutcome(completed)
    } catch {
      if (attempt === 0) continue
    }
  }
  await transaction((db) =>
    markRefundFailureWithDb(db, reservation.refund.invoice_id, "unknown", "persistence_failed", requestedAt),
  ).catch(() => undefined)
  throw new PaymentRefundOperationError("unknown", "persistence_failed")
}

async function reserveStoredRefundWithDb(
  db: Database.TxOrDb,
  invoiceID: string,
  requestKey: string,
  adapters: RefundAdapters,
  now: number,
) {
  const invoice = await db
    .select({
      id: PaymentCheckoutTable.id,
      workspaceID: PaymentCheckoutTable.workspace_id,
      accountID: PaymentCheckoutTable.account_id,
      provider: PaymentCheckoutTable.provider,
      merchantAccountID: PaymentCheckoutTable.merchant_account_id,
      externalInvoiceID: PaymentCheckoutTable.external_invoice_id,
      purpose: PaymentCheckoutTable.purpose,
      checkoutStatus: PaymentCheckoutTable.status,
      invoiceStatus: PaymentInvoiceTable.status,
      externalPaymentID: PaymentInvoiceTable.external_payment_id,
      amount: PaymentInvoiceTable.amount,
      currency: PaymentInvoiceTable.currency,
    })
    .from(PaymentCheckoutTable)
    .innerJoin(PaymentInvoiceTable, eq(PaymentInvoiceTable.id, PaymentCheckoutTable.id))
    .where(
      and(
        eq(PaymentCheckoutTable.id, invoiceID),
        isNull(PaymentCheckoutTable.timeDeleted),
        isNull(PaymentInvoiceTable.timeDeleted),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (!invoice || invoice.purpose !== "subscription" || !invoice.externalInvoiceID || !invoice.externalPaymentID) {
    throw new PaymentRefundConflictError("not_refundable")
  }

  const existing = await findRefund(db, invoice.id)
  if (existing?.status === "refunded") return { kind: "replay" as const, refund: existing }
  if (invoice.invoiceStatus === "refunded" || invoice.checkoutStatus === "refunded") {
    return { kind: "already_refunded" as const, invoice }
  }
  if (invoice.invoiceStatus !== "paid" || invoice.checkoutStatus !== "paid") {
    throw new PaymentRefundConflictError("not_refundable")
  }
  if (existing) {
    if (existing.status === "requested" && existing.time_requested.getTime() + REFUND_IN_PROGRESS_MS <= now) {
      await db
        .update(PaymentRefundTable)
        .set({ status: "unknown", error_code: "provider_result_unknown" })
        .where(and(eq(PaymentRefundTable.invoice_id, invoice.id), eq(PaymentRefundTable.status, "requested")))
      return {
        kind: "reconcile_unknown" as const,
        refund: await requireRefund(db, invoice.id),
        adapter: requireRefundAdapter(invoice, adapters),
      }
    }
    if (existing.status === "requested") throw new PaymentRefundConflictError("request_in_progress")
    if (existing.status === "unknown") {
      return { kind: "reconcile_unknown" as const, refund: existing, adapter: requireRefundAdapter(invoice, adapters) }
    }
    throw new PaymentRefundConflictError("request_failed")
  }

  const adapter = requireRefundAdapter(invoice, adapters)

  const requestReplay = await db
    .select({ invoiceID: PaymentRefundTable.invoice_id })
    .from(PaymentRefundTable)
    .where(
      and(eq(PaymentRefundTable.workspace_id, invoice.workspaceID), eq(PaymentRefundTable.request_key, requestKey)),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (requestReplay && requestReplay.invoiceID !== invoice.id) {
    throw new Error("Төлбөр буцаах хүсэлтийг дахин илгээхэд өөр нэхэмжлэхтэй зөрчилдөж байна")
  }

  const inserted = await db
    .insert(PaymentRefundTable)
    .values({
      invoice_id: invoice.id,
      workspace_id: invoice.workspaceID,
      account_id: invoice.accountID,
      request_key: requestKey,
      provider: invoice.provider,
      merchant_account_id: invoice.merchantAccountID,
      external_invoice_id: invoice.externalInvoiceID,
      external_payment_id: invoice.externalPaymentID,
      amount: invoice.amount,
      currency: invoice.currency,
      status: "requested",
      time_requested: new Date(now),
      timeCreated: new Date(now),
    })
    .onConflictDoNothing()
  if (resultChanges(inserted) !== 1) {
    const concurrent = await findRefund(db, invoice.id)
    if (!concurrent) throw new Error("Төлбөр буцаах нөөцлөлт зөрчилдлөө")
    if (concurrent.status === "refunded") return { kind: "replay" as const, refund: concurrent }
    throw new PaymentRefundConflictError(
      concurrent.status === "requested"
        ? "request_in_progress"
        : concurrent.status === "unknown"
          ? "result_unknown"
          : "request_failed",
    )
  }
  return {
    kind: "reserved" as const,
    refund: await requireRefund(db, invoice.id),
    adapter,
  }
}

async function completeRefundWithDb(
  db: Database.TxOrDb,
  invoiceID: string,
  receipt: Awaited<ReturnType<PaymentRefundAdapter["refundPayment"]>>,
  completedAt: number,
  expectedStatus: "requested" | "unknown",
) {
  const refund = await requireRefund(db, invoiceID)
  if (refund.status === "refunded") return refund
  if (refund.status !== expectedStatus) throw new Error("Төлбөр буцаах үйлдэл цааш үргэлжлэх боломжгүй болсон")
  if (
    receipt.provider !== refund.provider ||
    receipt.merchantAccountID !== refund.merchant_account_id ||
    receipt.externalInvoiceID !== refund.external_invoice_id ||
    receipt.externalPaymentID !== refund.external_payment_id ||
    receipt.amount !== refund.amount ||
    receipt.currency !== refund.currency
  ) {
    throw new Error("Төлбөр буцаасан баримтын мэдээлэл нөөцлөлттэй таарахгүй байна")
  }

  const changed = await db
    .update(PaymentRefundTable)
    .set({
      status: "refunded",
      error_code: null,
      provider_payload_hash: receipt.providerPayloadHash,
      time_completed: new Date(completedAt),
    })
    .where(and(eq(PaymentRefundTable.invoice_id, invoiceID), eq(PaymentRefundTable.status, expectedStatus)))
    .returning({ invoiceID: PaymentRefundTable.invoice_id })
  if (changed.length !== 1) throw new Error("Төлбөр буцаах мэдээлэл зэрэг өөрчлөгдсөн байна")
  return requireRefund(db, invoiceID)
}

function refundProviderRequest(refund: typeof PaymentRefundTable.$inferSelect) {
  return {
    externalInvoiceID: refund.external_invoice_id,
    externalPaymentID: refund.external_payment_id,
    amount: refund.amount,
    currency: refund.currency,
  }
}

function requireRefundAdapter(
  invoice: {
    provider: Provider
    merchantAccountID: string
  },
  adapters: RefundAdapters,
) {
  if (invoice.provider !== "qpay") throw new PaymentRefundUnsupportedError(invoice.provider)
  const adapter = adapters[invoice.provider]
  if (!adapter) throw new PaymentRefundUnavailableError(invoice.provider)
  if (adapter.provider !== invoice.provider || adapter.merchantAccountID !== invoice.merchantAccountID) {
    throw new Error("Төлбөр буцаах адаптерийн тохиргоо нэхэмжлэхтэй таарахгүй байна")
  }
  return adapter
}

async function markRefundFailureWithDb(
  db: Database.TxOrDb,
  invoiceID: string,
  status: "failed" | "unknown",
  code: string,
  occurredAt: number,
) {
  await db
    .update(PaymentRefundTable)
    .set({
      status,
      error_code: code,
      ...(status === "failed" ? { time_completed: new Date(occurredAt) } : {}),
    })
    .where(and(eq(PaymentRefundTable.invoice_id, invoiceID), eq(PaymentRefundTable.status, "requested")))
}

async function refundOutcome(refund: typeof PaymentRefundTable.$inferSelect): Promise<SubscriptionRefundOutcome> {
  if (refund.status !== "refunded" || !refund.time_completed || !refund.provider_payload_hash) {
    throw new Error("Төлбөрийн буцаалтын үр дүн бүрэн бус байна")
  }
  const occurredAt = refund.time_completed.getTime()
  return {
    result: SubscriptionPaymentRefundResultSchema.parse({
      invoiceID: refund.invoice_id,
      provider: refund.provider,
      status: "refunded",
    }),
    event: parseVerifiedPaymentEvent({
      provider: refund.provider,
      merchantAccountID: refund.merchant_account_id,
      externalEventID: await sha256Hex(
        `${refund.provider}:${refund.merchant_account_id}:${refund.external_payment_id}:refund-api`,
      ),
      externalInvoiceID: refund.external_invoice_id,
      externalPaymentID: refund.external_payment_id,
      amount: refund.amount,
      currency: refund.currency,
      type: "refunded",
      payloadHash: refund.provider_payload_hash,
      occurredAt,
    }),
  }
}

function classifyRefundFailure(error: unknown) {
  if (error instanceof PaymentProviderResponseError && error.status >= 400 && error.status < 500) {
    return { state: "failed" as const, code: `provider_${error.status}` }
  }
  if (error instanceof PaymentProviderResponseError) {
    return { state: "unknown" as const, code: `provider_${error.status}` }
  }
  return { state: "unknown" as const, code: "provider_uncertain" }
}

function validateTimestamp(value: number, lowerBound = 0) {
  if (!Number.isSafeInteger(value) || value < lowerBound) throw new TypeError("Төлбөр буцаах цагийн тэмдэг буруу байна")
}

function findRefund(db: Database.TxOrDb, invoiceID: string) {
  return db
    .select()
    .from(PaymentRefundTable)
    .where(eq(PaymentRefundTable.invoice_id, invoiceID))
    .limit(1)
    .then((rows) => rows[0])
}

async function requireRefund(db: Database.TxOrDb, invoiceID: string) {
  const refund = await findRefund(db, invoiceID)
  if (!refund) throw new Error("Төлбөр буцаах нөөцлөлт олдсонгүй")
  return refund
}

function resultChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0
  if ("meta" in result && result.meta && typeof result.meta === "object" && "changes" in result.meta) {
    return Number(result.meta.changes ?? 0)
  }
  if ("changes" in result) return Number(result.changes ?? 0)
  return 0
}
