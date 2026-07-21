import { and, Database, eq, isNull } from "./drizzle"
import {
  PaymentCancellationStateSchema,
  SubscriptionCheckoutCancellationRequestSchema,
  SubscriptionCheckoutCancellationResultSchema,
  type SubscriptionCheckoutCancellationRequest,
  type SubscriptionCheckoutCancellationResult,
} from "./payment-cancellation-contract"
import {
  PaymentProviderResponseError,
  parseVerifiedPaymentEvent,
  sha256Hex,
  stableJson,
  type PaymentCancellationAdapter,
  type VerifiedPaymentEvent,
} from "./payment-provider"
import {
  PaymentCancellationTable,
  PaymentCheckoutTable,
  PaymentInvoiceTable,
  PaymentProviders,
} from "./schema/billing.sql"
import { UserTable } from "./schema/user.sql"

const CANCELLATION_IN_PROGRESS_MS = 2 * 60 * 1_000

type Transaction = <T>(callback: (db: Database.TxOrDb) => Promise<T>) => Promise<T>
type Provider = (typeof PaymentProviders)[number]
type CancellationAdapters = Partial<Record<Provider, PaymentCancellationAdapter>>

export {
  PaymentCancellationStateSchema,
  SubscriptionCheckoutCancellationRequestSchema,
  SubscriptionCheckoutCancellationResultSchema,
  type SubscriptionCheckoutCancellationRequest,
  type SubscriptionCheckoutCancellationResult,
} from "./payment-cancellation-contract"

export type SubscriptionCancellationOutcome = {
  result: SubscriptionCheckoutCancellationResult
  event?: VerifiedPaymentEvent
}

export class PaymentCancellationAuthorizationError extends Error {
  constructor() {
    super("Payment cancellation requires an active workspace administrator")
    this.name = "PaymentCancellationAuthorizationError"
  }
}

export class PaymentCancellationUnsupportedError extends Error {
  constructor(readonly provider: Provider) {
    super(`${provider} invoice cancellation is not supported`)
    this.name = "PaymentCancellationUnsupportedError"
  }
}

export class PaymentCancellationUnavailableError extends Error {
  constructor(readonly provider: Provider) {
    super(`${provider} invoice cancellation is unavailable`)
    this.name = "PaymentCancellationUnavailableError"
  }
}

export class PaymentCancellationConflictError extends Error {
  constructor(
    readonly state: "settled" | "not_cancellable" | "request_in_progress" | "result_unknown" | "request_failed",
  ) {
    super(`Payment cancellation conflict: ${state}`)
    this.name = "PaymentCancellationConflictError"
  }
}

export class PaymentCancellationOperationError extends Error {
  constructor(
    readonly state: "failed" | "unknown",
    readonly code: string,
  ) {
    super(`Payment cancellation ${state}: ${code}`)
    this.name = "PaymentCancellationOperationError"
  }
}

export async function cancelSubscriptionCheckout(
  input: SubscriptionCheckoutCancellationRequest,
  dependencies: {
    adapters: CancellationAdapters
    transaction?: Transaction
    now?: () => number
  },
): Promise<SubscriptionCancellationOutcome> {
  const request = SubscriptionCheckoutCancellationRequestSchema.parse(input)
  const now = dependencies.now ?? Date.now
  const requestedAt = now()
  validateTimestamp(requestedAt)
  const transaction = dependencies.transaction ?? ((callback) => Database.transaction(callback))

  const reservation = await transaction((db) =>
    reserveCancellationWithDb(db, request, dependencies.adapters, requestedAt),
  )
  if (reservation.kind === "already_cancelled") {
    return {
      result: SubscriptionCheckoutCancellationResultSchema.parse({
        invoiceID: reservation.invoice.id,
        provider: reservation.invoice.provider,
        status: "cancelled",
      }),
    }
  }
  if (reservation.kind === "replay") return cancellationOutcome(reservation.cancellation)
  if (reservation.kind === "stale_unknown") throw new PaymentCancellationConflictError("result_unknown")

  let receipt: Awaited<ReturnType<PaymentCancellationAdapter["cancelInvoice"]>>
  try {
    receipt = await reservation.adapter.cancelInvoice({
      externalInvoiceID: reservation.externalInvoiceID,
    })
  } catch (error) {
    const failure = classifyCancellationFailure(error)
    const failedAt = now()
    validateTimestamp(failedAt, requestedAt)
    await transaction((db) =>
      markCancellationFailureWithDb(db, reservation.invoice.id, failure.state, failure.code, failedAt),
    ).catch(() => undefined)
    throw new PaymentCancellationOperationError(failure.state, failure.code)
  }

  const completedAt = now()
  validateTimestamp(completedAt, requestedAt)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completed = await transaction((db) =>
        completeCancellationWithDb(db, reservation.invoice.id, receipt, completedAt),
      )
      return cancellationOutcome(completed)
    } catch {
      if (attempt === 0) continue
    }
  }
  await transaction((db) =>
    markCancellationFailureWithDb(db, reservation.invoice.id, "unknown", "persistence_failed", requestedAt),
  ).catch(() => undefined)
  throw new PaymentCancellationOperationError("unknown", "persistence_failed")
}

async function reserveCancellationWithDb(
  db: Database.TxOrDb,
  input: ReturnType<typeof SubscriptionCheckoutCancellationRequestSchema.parse>,
  adapters: CancellationAdapters,
  now: number,
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
  if (!administrator) throw new PaymentCancellationAuthorizationError()

  const invoice = await db
    .select({
      id: PaymentCheckoutTable.id,
      provider: PaymentCheckoutTable.provider,
      merchant_account_id: PaymentCheckoutTable.merchant_account_id,
      external_invoice_id: PaymentCheckoutTable.external_invoice_id,
      purpose: PaymentCheckoutTable.purpose,
      checkoutStatus: PaymentCheckoutTable.status,
      invoiceStatus: PaymentInvoiceTable.status,
    })
    .from(PaymentCheckoutTable)
    .leftJoin(PaymentInvoiceTable, eq(PaymentInvoiceTable.id, PaymentCheckoutTable.id))
    .where(
      and(
        eq(PaymentCheckoutTable.id, input.invoiceID),
        eq(PaymentCheckoutTable.workspace_id, input.workspaceID),
        isNull(PaymentCheckoutTable.timeDeleted),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (!invoice || !invoice.external_invoice_id || !invoice.invoiceStatus || invoice.purpose !== "subscription") {
    throw new PaymentCancellationConflictError("not_cancellable")
  }
  if (
    invoice.checkoutStatus === "paid" ||
    invoice.checkoutStatus === "refunded" ||
    invoice.invoiceStatus === "paid" ||
    invoice.invoiceStatus === "refunded"
  ) {
    throw new PaymentCancellationConflictError("settled")
  }

  const existing = await findCancellation(db, invoice.id)
  if (existing) {
    if (existing.status === "cancelled") return { kind: "replay" as const, cancellation: existing }
    if (existing.status === "requested" && existing.time_requested.getTime() + CANCELLATION_IN_PROGRESS_MS <= now) {
      await db
        .update(PaymentCancellationTable)
        .set({ status: "unknown", error_code: "provider_result_unknown" })
        .where(
          and(eq(PaymentCancellationTable.invoice_id, invoice.id), eq(PaymentCancellationTable.status, "requested")),
        )
      return { kind: "stale_unknown" as const }
    }
    if (existing.status === "requested") throw new PaymentCancellationConflictError("request_in_progress")
    if (existing.status === "unknown") throw new PaymentCancellationConflictError("result_unknown")
    throw new PaymentCancellationConflictError("request_failed")
  }

  if (invoice.checkoutStatus === "cancelled" || invoice.invoiceStatus === "cancelled") {
    return { kind: "already_cancelled" as const, invoice }
  }
  if (invoice.provider !== "qpay") throw new PaymentCancellationUnsupportedError(invoice.provider)
  const adapter = adapters[invoice.provider]
  if (!adapter) throw new PaymentCancellationUnavailableError(invoice.provider)
  if (adapter.provider !== invoice.provider || adapter.merchantAccountID !== invoice.merchant_account_id) {
    throw new Error("Payment cancellation adapter binding does not match invoice")
  }
  const checkoutCancellable = invoice.checkoutStatus === "ready" || invoice.checkoutStatus === "pending"
  const invoiceCancellable = invoice.invoiceStatus === "created" || invoice.invoiceStatus === "pending"
  if (!checkoutCancellable || !invoiceCancellable) {
    throw new PaymentCancellationConflictError("not_cancellable")
  }

  const requestReplay = await db
    .select({ invoiceID: PaymentCancellationTable.invoice_id })
    .from(PaymentCancellationTable)
    .where(
      and(
        eq(PaymentCancellationTable.workspace_id, input.workspaceID),
        eq(PaymentCancellationTable.request_key, input.requestKey),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (requestReplay && requestReplay.invoiceID !== invoice.id) {
    throw new Error("Payment cancellation request replay conflicts with another invoice")
  }

  const inserted = await db
    .insert(PaymentCancellationTable)
    .values({
      invoice_id: invoice.id,
      workspace_id: input.workspaceID,
      account_id: input.accountID,
      request_key: input.requestKey,
      provider: invoice.provider,
      merchant_account_id: invoice.merchant_account_id,
      external_invoice_id: invoice.external_invoice_id,
      status: "requested",
      time_requested: new Date(now),
      timeCreated: new Date(now),
    })
    .onConflictDoNothing()
  if (resultChanges(inserted) !== 1) {
    const concurrent = await findCancellation(db, invoice.id)
    if (!concurrent) throw new Error("Payment cancellation reservation conflict")
    if (concurrent.status === "cancelled") return { kind: "replay" as const, cancellation: concurrent }
    throw new PaymentCancellationConflictError(
      concurrent.status === "requested"
        ? "request_in_progress"
        : concurrent.status === "unknown"
          ? "result_unknown"
          : "request_failed",
    )
  }
  return { kind: "reserved" as const, invoice, externalInvoiceID: invoice.external_invoice_id, adapter }
}

async function completeCancellationWithDb(
  db: Database.TxOrDb,
  invoiceID: string,
  receipt: Awaited<ReturnType<PaymentCancellationAdapter["cancelInvoice"]>>,
  completedAt: number,
) {
  const cancellation = await requireCancellation(db, invoiceID)
  if (cancellation.status === "cancelled") return cancellation
  if (cancellation.status !== "requested") throw new Error("Payment cancellation is no longer in progress")
  if (
    receipt.provider !== cancellation.provider ||
    receipt.merchantAccountID !== cancellation.merchant_account_id ||
    receipt.externalInvoiceID !== cancellation.external_invoice_id
  ) {
    throw new Error("Payment cancellation receipt binding does not match reservation")
  }

  const changed = await db
    .update(PaymentCancellationTable)
    .set({
      status: "cancelled",
      error_code: null,
      time_completed: new Date(completedAt),
    })
    .where(and(eq(PaymentCancellationTable.invoice_id, invoiceID), eq(PaymentCancellationTable.status, "requested")))
    .returning({ invoiceID: PaymentCancellationTable.invoice_id })
  if (changed.length !== 1) throw new Error("Payment cancellation changed concurrently")
  return requireCancellation(db, invoiceID)
}

async function markCancellationFailureWithDb(
  db: Database.TxOrDb,
  invoiceID: string,
  status: "failed" | "unknown",
  code: string,
  occurredAt: number,
) {
  await db
    .update(PaymentCancellationTable)
    .set({
      status,
      error_code: code,
      ...(status === "failed" ? { time_completed: new Date(occurredAt) } : {}),
    })
    .where(and(eq(PaymentCancellationTable.invoice_id, invoiceID), eq(PaymentCancellationTable.status, "requested")))
}

async function cancellationOutcome(
  cancellation: typeof PaymentCancellationTable.$inferSelect,
): Promise<SubscriptionCancellationOutcome> {
  if (cancellation.status !== "cancelled" || !cancellation.time_completed) {
    throw new Error("Payment cancellation result is incomplete")
  }
  const occurredAt = cancellation.time_completed.getTime()
  const normalized = {
    operation: "invoice_cancelled",
    provider: cancellation.provider,
    merchantAccountID: cancellation.merchant_account_id,
    externalInvoiceID: cancellation.external_invoice_id,
    invoiceID: cancellation.invoice_id,
    occurredAt,
  }
  return {
    result: SubscriptionCheckoutCancellationResultSchema.parse({
      invoiceID: cancellation.invoice_id,
      provider: cancellation.provider,
      status: "cancelled",
    }),
    event: parseVerifiedPaymentEvent({
      provider: cancellation.provider,
      merchantAccountID: cancellation.merchant_account_id,
      externalEventID: await sha256Hex(
        `${cancellation.provider}:${cancellation.merchant_account_id}:${cancellation.external_invoice_id}:cancelled`,
      ),
      externalInvoiceID: cancellation.external_invoice_id,
      type: "cancelled",
      payloadHash: await sha256Hex(stableJson(normalized)),
      occurredAt,
    }),
  }
}

function classifyCancellationFailure(error: unknown) {
  if (error instanceof PaymentProviderResponseError && (error.status === 401 || error.status === 403)) {
    return { state: "failed" as const, code: `provider_${error.status}` }
  }
  if (error instanceof PaymentProviderResponseError) {
    return { state: "unknown" as const, code: `provider_${error.status}` }
  }
  return { state: "unknown" as const, code: "provider_uncertain" }
}

function validateTimestamp(value: number, lowerBound = 0) {
  if (!Number.isSafeInteger(value) || value < lowerBound)
    throw new TypeError("Payment cancellation timestamp is invalid")
}

function findCancellation(db: Database.TxOrDb, invoiceID: string) {
  return db
    .select()
    .from(PaymentCancellationTable)
    .where(eq(PaymentCancellationTable.invoice_id, invoiceID))
    .limit(1)
    .then((rows) => rows[0])
}

async function requireCancellation(db: Database.TxOrDb, invoiceID: string) {
  const cancellation = await findCancellation(db, invoiceID)
  if (!cancellation) throw new Error("Payment cancellation reservation disappeared")
  return cancellation
}

function resultChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0
  if ("meta" in result && result.meta && typeof result.meta === "object" && "changes" in result.meta) {
    return Number(result.meta.changes ?? 0)
  }
  if ("changes" in result) return Number(result.changes ?? 0)
  return 0
}
