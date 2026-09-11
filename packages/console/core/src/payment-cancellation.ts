import { and, Database, eq, exists, isNull, sql, type SQL } from "./drizzle"
import { paymentBatchGuard, type PaymentBatchDatabase } from "./payment-ledger"
import {
  PaymentCancellationStateSchema,
  PlatformAdminSubscriptionCheckoutCancellationRequestSchema,
  SubscriptionCheckoutCancellationRequestSchema,
  type PlatformAdminSubscriptionCheckoutCancellationRequest,
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

type Provider = (typeof PaymentProviders)[number]
type CancellationAdapters = Partial<Record<Provider, PaymentCancellationAdapter>>

export {
  PaymentCancellationStateSchema,
  PlatformAdminSubscriptionCheckoutCancellationRequestSchema,
  SubscriptionCheckoutCancellationRequestSchema,
  type PlatformAdminSubscriptionCheckoutCancellationRequest,
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
    super("Төлбөр цуцлахад ажлын талбарын идэвхтэй администратор шаардлагатай")
    this.name = "PaymentCancellationAuthorizationError"
  }
}

export class PaymentCancellationUnsupportedError extends Error {
  constructor(readonly provider: Provider) {
    super(`${provider} нэхэмжлэх цуцлах үйлдлийг дэмжихгүй байна`)
    this.name = "PaymentCancellationUnsupportedError"
  }
}

export class PaymentCancellationUnavailableError extends Error {
  constructor(readonly provider: Provider) {
    super(`${provider} нэхэмжлэх цуцлах үйлдлийг ашиглах боломжгүй байна`)
    this.name = "PaymentCancellationUnavailableError"
  }
}

export class PaymentCancellationConflictError extends Error {
  constructor(
    readonly state: "settled" | "not_cancellable" | "request_in_progress" | "result_unknown" | "request_failed",
  ) {
    super(`Төлбөр цуцлахад зөрчил гарлаа: ${state}`)
    this.name = "PaymentCancellationConflictError"
  }
}

export class PaymentCancellationOperationError extends Error {
  constructor(
    readonly state: "failed" | "unknown",
    readonly code: string,
  ) {
    super(`Төлбөр цуцлах ${state} төлөвтэй байна: ${code}`)
    this.name = "PaymentCancellationOperationError"
  }
}

export async function cancelSubscriptionCheckout(
  input: SubscriptionCheckoutCancellationRequest,
  dependencies: {
    adapters: CancellationAdapters
    batch?: typeof Database.batch
    now?: () => number
  },
): Promise<SubscriptionCancellationOutcome> {
  const request = SubscriptionCheckoutCancellationRequestSchema.parse(input)
  const now = dependencies.now ?? Date.now
  const requestedAt = now()
  validateTimestamp(requestedAt)
  const batch = dependencies.batch ?? Database.batch
  const reservation = await reserveStoredCancellation(
    batch,
    request.invoiceID,
    request.requestKey,
    dependencies.adapters,
    requestedAt,
    {
      expectedWorkspaceID: request.workspaceID,
      actorAccountID: request.accountID,
    },
  )
  return finishCancellationReservation(reservation, batch, now, requestedAt)
}

/**
 * This is intentionally a separate entry point from workspace-member cancellation.
 * It accepts no payment scope; the stored checkout is the sole source of truth.
 * The ledger account stays bound to the checkout owner for retention and account deletion;
 * the platform administrator actor is recorded by the immutable admin audit before this call.
 */
export async function cancelPlatformAdminSubscriptionCheckout(
  input: PlatformAdminSubscriptionCheckoutCancellationRequest,
  dependencies: {
    adapters: CancellationAdapters
    batch?: typeof Database.batch
    now?: () => number
  },
): Promise<SubscriptionCancellationOutcome> {
  const request = PlatformAdminSubscriptionCheckoutCancellationRequestSchema.parse(input)
  const now = dependencies.now ?? Date.now
  const requestedAt = now()
  validateTimestamp(requestedAt)
  const batch = dependencies.batch ?? Database.batch
  const reservation = await reserveStoredCancellation(
    batch,
    request.invoiceID,
    request.requestKey,
    dependencies.adapters,
    requestedAt,
  )
  return finishCancellationReservation(reservation, batch, now, requestedAt)
}

async function finishCancellationReservation(
  reservation: Awaited<ReturnType<typeof reserveStoredCancellation>>,
  batch: typeof Database.batch,
  now: () => number,
  requestedAt: number,
): Promise<SubscriptionCancellationOutcome> {
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
    await markCancellationFailure(batch, reservation.invoice.id, failure.state, failure.code, failedAt).catch(
      () => undefined,
    )
    throw new PaymentCancellationOperationError(failure.state, failure.code)
  }

  const completedAt = now()
  validateTimestamp(completedAt, requestedAt)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completed = await completeCancellation(batch, reservation.invoice.id, receipt, completedAt)
      return cancellationOutcome(completed)
    } catch {
      if (attempt === 0) continue
    }
  }
  await markCancellationFailure(batch, reservation.invoice.id, "unknown", "persistence_failed", requestedAt).catch(
    () => undefined,
  )
  throw new PaymentCancellationOperationError("unknown", "persistence_failed")
}

type CancellationScope = { expectedWorkspaceID: string; actorAccountID: string }

function cancellationAuthorization(db: PaymentBatchDatabase, scope?: CancellationScope) {
  if (!scope) return sql`1`
  return exists(
    db
      .select({ id: UserTable.id })
      .from(UserTable)
      .where(
        and(
          eq(UserTable.workspaceID, scope.expectedWorkspaceID),
          eq(UserTable.accountID, scope.actorAccountID),
          eq(UserTable.role, "admin"),
          isNull(UserTable.timeDeleted),
        ),
      )
      .limit(1),
  )
}

function cancellationInvoice(
  db: PaymentBatchDatabase,
  invoiceID: string,
  options?: CancellationScope,
  condition?: SQL,
) {
  return db
    .select({
      id: PaymentCheckoutTable.id,
      workspaceID: PaymentCheckoutTable.workspace_id,
      accountID: PaymentCheckoutTable.account_id,
      provider: PaymentCheckoutTable.provider,
      merchant_account_id: PaymentCheckoutTable.merchant_account_id,
      external_invoice_id: PaymentCheckoutTable.external_invoice_id,
      purpose: PaymentCheckoutTable.purpose,
      // D1 batch rows are objects: duplicate SQL column names collapse before Drizzle maps them.
      checkoutStatus: sql<typeof PaymentCheckoutTable.$inferSelect.status>`${PaymentCheckoutTable.status}`.as(
        "checkout_status",
      ),
      invoiceStatus: sql<typeof PaymentInvoiceTable.$inferSelect.status>`${PaymentInvoiceTable.status}`.as(
        "invoice_status",
      ),
    })
    .from(PaymentCheckoutTable)
    .innerJoin(
      PaymentInvoiceTable,
      and(
        eq(PaymentInvoiceTable.id, PaymentCheckoutTable.id),
        eq(PaymentInvoiceTable.workspace_id, PaymentCheckoutTable.workspace_id),
        eq(PaymentInvoiceTable.provider, PaymentCheckoutTable.provider),
        eq(PaymentInvoiceTable.merchant_account_id, PaymentCheckoutTable.merchant_account_id),
        eq(PaymentInvoiceTable.external_invoice_id, PaymentCheckoutTable.external_invoice_id),
        eq(PaymentInvoiceTable.purpose, PaymentCheckoutTable.purpose),
      ),
    )
    .where(
      and(
        eq(PaymentCheckoutTable.id, invoiceID),
        options?.expectedWorkspaceID ? eq(PaymentCheckoutTable.workspace_id, options.expectedWorkspaceID) : undefined,
        isNull(PaymentCheckoutTable.timeDeleted),
        isNull(PaymentInvoiceTable.timeDeleted),
        condition,
      ),
    )
    .limit(1)
}

async function reserveStoredCancellation(
  batch: typeof Database.batch,
  invoiceID: string,
  requestKey: string,
  adapters: CancellationAdapters,
  now: number,
  options?: CancellationScope,
) {
  const [[invoice], [existing], [authorization]] = await batch((db) => [
    cancellationInvoice(db, invoiceID, options),
    findCancellation(db, invoiceID),
    db.select({ allowed: cancellationAuthorization(db, options).mapWith(Number) }).from(sql`(select 1)`),
  ])
  if (!authorization.allowed) throw new PaymentCancellationAuthorizationError()
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

  if (existing) {
    if (existing.status === "cancelled") return { kind: "replay" as const, cancellation: existing }
    if (existing.status === "requested" && existing.time_requested.getTime() + CANCELLATION_IN_PROGRESS_MS <= now) {
      const [, , [current]] = await batch((db) => [
        paymentBatchGuard(db, cancellationAuthorization(db, options)),
        db
          .update(PaymentCancellationTable)
          .set({ status: "unknown", error_code: "provider_result_unknown" })
          .where(
            and(
              eq(PaymentCancellationTable.invoice_id, invoice.id),
              eq(PaymentCancellationTable.status, "requested"),
              eq(PaymentCancellationTable.time_requested, existing.time_requested),
            ),
          ),
        findCancellation(db, invoice.id),
      ])
      if (current?.status === "cancelled") return { kind: "replay" as const, cancellation: current }
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
    throw new Error("Төлбөр цуцлах адаптерийн тохиргоо нэхэмжлэхтэй таарахгүй байна")
  }
  const checkoutCancellable = invoice.checkoutStatus === "ready" || invoice.checkoutStatus === "pending"
  const invoiceCancellable = invoice.invoiceStatus === "created" || invoice.invoiceStatus === "pending"
  if (!checkoutCancellable || !invoiceCancellable) {
    throw new PaymentCancellationConflictError("not_cancellable")
  }

  // Authorization and the cancellable snapshot must still hold when the reservation commits.
  const [, inserted, [current], [requestReplay]] = await batch((db) => [
    paymentBatchGuard(
      db,
      and(
        cancellationAuthorization(db, options),
        exists(
          cancellationInvoice(
            db,
            invoice.id,
            options,
            and(
              eq(PaymentCheckoutTable.workspace_id, invoice.workspaceID),
              eq(PaymentCheckoutTable.account_id, invoice.accountID),
              eq(PaymentCheckoutTable.provider, invoice.provider),
              eq(PaymentCheckoutTable.merchant_account_id, invoice.merchant_account_id),
              eq(PaymentCheckoutTable.external_invoice_id, invoice.external_invoice_id!),
              eq(PaymentCheckoutTable.purpose, invoice.purpose),
              eq(PaymentCheckoutTable.status, invoice.checkoutStatus),
              eq(PaymentInvoiceTable.status, invoice.invoiceStatus),
            ),
          ),
        ),
      ),
    ),
    db
      .insert(PaymentCancellationTable)
      .values({
        invoice_id: invoice.id,
        workspace_id: invoice.workspaceID,
        account_id: options?.actorAccountID ?? invoice.accountID,
        request_key: requestKey,
        provider: invoice.provider,
        merchant_account_id: invoice.merchant_account_id,
        external_invoice_id: invoice.external_invoice_id!,
        status: "requested",
        time_requested: new Date(now),
        timeCreated: new Date(now),
      })
      .onConflictDoNothing()
      .returning(),
    findCancellation(db, invoice.id),
    db
      .select({ invoiceID: PaymentCancellationTable.invoice_id })
      .from(PaymentCancellationTable)
      .where(
        and(
          eq(PaymentCancellationTable.workspace_id, invoice.workspaceID),
          eq(PaymentCancellationTable.request_key, requestKey),
        ),
      )
      .limit(1),
  ])
  if (inserted.length !== 1) {
    if (requestReplay && requestReplay.invoiceID !== invoice.id) {
      throw new Error("Төлбөр цуцлах хүсэлтийг дахин илгээхэд өөр нэхэмжлэхтэй зөрчилдөж байна")
    }
    const concurrent = current
    if (!concurrent) throw new Error("Төлбөр цуцлах нөөцлөлт зөрчилдлөө")
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

async function completeCancellation(
  batch: typeof Database.batch,
  invoiceID: string,
  receipt: Awaited<ReturnType<PaymentCancellationAdapter["cancelInvoice"]>>,
  completedAt: number,
) {
  const [, [cancellation]] = await batch((db) => [
    db
      .update(PaymentCancellationTable)
      .set({
        status: "cancelled",
        error_code: null,
        time_completed: new Date(completedAt),
      })
      .where(
        and(
          eq(PaymentCancellationTable.invoice_id, invoiceID),
          eq(PaymentCancellationTable.status, "requested"),
          eq(PaymentCancellationTable.provider, receipt.provider),
          eq(PaymentCancellationTable.merchant_account_id, receipt.merchantAccountID),
          eq(PaymentCancellationTable.external_invoice_id, receipt.externalInvoiceID),
        ),
      ),
    findCancellation(db, invoiceID),
  ])
  if (!cancellation) throw new Error("Төлбөр цуцлах нөөцлөлт олдсонгүй")
  if (
    receipt.provider !== cancellation.provider ||
    receipt.merchantAccountID !== cancellation.merchant_account_id ||
    receipt.externalInvoiceID !== cancellation.external_invoice_id
  ) {
    throw new Error("Төлбөр цуцалсан баримтын мэдээлэл нөөцлөлттэй таарахгүй байна")
  }

  if (cancellation.status !== "cancelled") throw new Error("Төлбөр цуцлах мэдээлэл зэрэг өөрчлөгдсөн байна")
  return cancellation
}

async function markCancellationFailure(
  batch: typeof Database.batch,
  invoiceID: string,
  status: "failed" | "unknown",
  code: string,
  occurredAt: number,
) {
  await batch((db) => [
    db
      .update(PaymentCancellationTable)
      .set({
        status,
        error_code: code,
        ...(status === "failed" ? { time_completed: new Date(occurredAt) } : {}),
      })
      .where(and(eq(PaymentCancellationTable.invoice_id, invoiceID), eq(PaymentCancellationTable.status, "requested"))),
  ])
}

async function cancellationOutcome(
  cancellation: typeof PaymentCancellationTable.$inferSelect,
): Promise<SubscriptionCancellationOutcome> {
  if (cancellation.status !== "cancelled" || !cancellation.time_completed) {
    throw new Error("Төлбөр цуцлалтын үр дүн бүрэн бус байна")
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
  if (!Number.isSafeInteger(value) || value < lowerBound) throw new TypeError("Төлбөр цуцлах цагийн тэмдэг буруу байна")
}

function findCancellation(db: PaymentBatchDatabase, invoiceID: string) {
  return db.select().from(PaymentCancellationTable).where(eq(PaymentCancellationTable.invoice_id, invoiceID)).limit(1)
}
