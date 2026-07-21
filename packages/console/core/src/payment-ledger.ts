import { and, Database, eq } from "./drizzle"
import { Identifier } from "./identifier"
import {
  PaymentEventTable,
  PaymentEventTypes,
  PaymentInvoiceStatuses,
  PaymentInvoiceTable,
  PaymentProviders,
  PaymentPurposes,
  PlanNames,
} from "./schema/billing.sql"
import { z } from "zod"

const identifier = z.string().trim().min(1).max(30)
const externalIdentifier = z.string().trim().min(1).max(255)
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)

export const RecordPaymentInvoiceSchema = z
  .object({
    id: identifier.optional(),
    workspaceID: identifier,
    provider: z.enum(PaymentProviders),
    merchantAccountID: externalIdentifier,
    externalInvoiceID: externalIdentifier,
    purpose: z.enum(PaymentPurposes),
    plan: z.enum(PlanNames).optional(),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("MNT").default("MNT"),
    expiresAt: timestamp.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.purpose === "subscription" && !input.plan) {
      context.addIssue({
        code: "custom",
        path: ["plan"],
        message: "Subscription invoice requires a plan",
      })
    }
    if (input.purpose === "credit" && input.plan) {
      context.addIssue({
        code: "custom",
        path: ["plan"],
        message: "Credit invoice cannot include a plan",
      })
    }
  })

export const ApplyPaymentEventSchema = z
  .object({
    id: identifier.optional(),
    provider: z.enum(PaymentProviders),
    merchantAccountID: externalIdentifier,
    externalEventID: externalIdentifier,
    externalInvoiceID: externalIdentifier,
    externalPaymentID: externalIdentifier.optional(),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    currency: z.literal("MNT").optional(),
    type: z.enum(PaymentEventTypes),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    occurredAt: timestamp,
  })
  .strict()
  .superRefine((input, context) => {
    const settlement = input.type === "paid" || input.type === "refunded"
    if (settlement && !input.externalPaymentID) {
      context.addIssue({
        code: "custom",
        path: ["externalPaymentID"],
        message: `${input.type} event requires an external payment ID`,
      })
    }
    if (settlement && input.amount === undefined) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: `${input.type} event requires an amount`,
      })
    }
    if (settlement && input.currency === undefined) {
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: `${input.type} event requires a currency`,
      })
    }
    if ((input.amount === undefined) !== (input.currency === undefined)) {
      context.addIssue({
        code: "custom",
        path: input.amount === undefined ? ["amount"] : ["currency"],
        message: "Payment event amount and currency must be provided together",
      })
    }
  })

export type RecordPaymentInvoiceInput = z.input<typeof RecordPaymentInvoiceSchema>
export type ApplyPaymentEventInput = z.input<typeof ApplyPaymentEventSchema>
export type PaymentInvoiceStatus = (typeof PaymentInvoiceStatuses)[number]
export type PaymentTransitionOutcome = "applied" | "noop" | "rejected"
export type PaymentTransitionEffect = (input: {
  db: Database.TxOrDb
  invoice: typeof PaymentInvoiceTable.$inferSelect
  previousStatus: PaymentInvoiceStatus
  event: ApplyPaymentEventInput
}) => Promise<void>

export async function recordPaymentInvoiceWithDb(db: Database.TxOrDb, input: RecordPaymentInvoiceInput) {
  const invoice = RecordPaymentInvoiceSchema.parse(input)
  const inserted = await db
    .insert(PaymentInvoiceTable)
    .values({
      id: invoice.id ?? Identifier.create("paymentInvoice"),
      workspace_id: invoice.workspaceID,
      provider: invoice.provider,
      merchant_account_id: invoice.merchantAccountID,
      external_invoice_id: invoice.externalInvoiceID,
      purpose: invoice.purpose,
      plan: invoice.plan,
      amount: invoice.amount,
      currency: invoice.currency,
      time_expires: invoice.expiresAt === undefined ? undefined : new Date(invoice.expiresAt),
    })
    .onConflictDoNothing()

  const stored = await db
    .select()
    .from(PaymentInvoiceTable)
    .where(
      and(
        eq(PaymentInvoiceTable.provider, invoice.provider),
        eq(PaymentInvoiceTable.merchant_account_id, invoice.merchantAccountID),
        eq(PaymentInvoiceTable.external_invoice_id, invoice.externalInvoiceID),
      ),
    )
    .then((rows) => rows[0])
  if (!stored) throw new Error("Payment invoice insert did not persist")

  if (resultChanges(inserted) === 0) {
    assertInvoiceReplay(stored, invoice)
    return { kind: "duplicate" as const, invoice: stored }
  }
  return { kind: "created" as const, invoice: stored }
}

export function recordPaymentInvoice(input: RecordPaymentInvoiceInput) {
  return Database.transaction((db) => recordPaymentInvoiceWithDb(db, input))
}

// The caller must provide an active transaction. External callers should use applyPaymentEvent.
export async function applyPaymentEventWithDb(
  db: Database.TxOrDb,
  input: ApplyPaymentEventInput,
  effect?: PaymentTransitionEffect,
) {
  const event = ApplyPaymentEventSchema.parse(input)
  const invoice = await db
    .select()
    .from(PaymentInvoiceTable)
    .where(
      and(
        eq(PaymentInvoiceTable.provider, event.provider),
        eq(PaymentInvoiceTable.merchant_account_id, event.merchantAccountID),
        eq(PaymentInvoiceTable.external_invoice_id, event.externalInvoiceID),
      ),
    )
    .then((rows) => rows[0])
  if (!invoice) throw new Error("Payment invoice not found")
  if (
    invoice.external_payment_id &&
    event.externalPaymentID &&
    invoice.external_payment_id !== event.externalPaymentID
  ) {
    throw new Error("Payment event references a different external payment")
  }
  if (event.amount !== undefined && (event.amount !== invoice.amount || event.currency !== invoice.currency)) {
    throw new Error("Payment event amount or currency does not match the invoice")
  }

  const replay = await findPaymentEvent(db, event.provider, event.merchantAccountID, event.externalEventID)
  if (replay) {
    assertEventReplay(replay, event)
    return {
      kind: "duplicate" as const,
      outcome: replay.outcome,
      invoice,
    }
  }

  const outcome = paymentTransition(invoice.status, event.type)
  const inserted = await db
    .insert(PaymentEventTable)
    .values({
      id: event.id ?? Identifier.create("paymentEvent"),
      invoice_id: invoice.id,
      workspace_id: invoice.workspace_id,
      provider: event.provider,
      merchant_account_id: event.merchantAccountID,
      external_event_id: event.externalEventID,
      external_invoice_id: event.externalInvoiceID,
      external_payment_id: event.externalPaymentID,
      amount: event.amount,
      currency: event.currency,
      type: event.type,
      outcome,
      from_status: invoice.status,
      to_status: event.type,
      payload_hash: event.payloadHash,
      time_occurred: new Date(event.occurredAt),
    })
    .onConflictDoNothing()

  if (resultChanges(inserted) === 0) {
    const concurrent = await findPaymentEvent(db, event.provider, event.merchantAccountID, event.externalEventID)
    if (!concurrent) throw new Error("Payment event uniqueness conflict")
    assertEventReplay(concurrent, event)
    return {
      kind: "duplicate" as const,
      outcome: concurrent.outcome,
      invoice: await requirePaymentInvoice(db, invoice.id),
    }
  }

  if (outcome !== "applied") {
    return {
      kind: outcome,
      outcome,
      invoice,
    }
  }

  const occurredAt = new Date(event.occurredAt)
  const updated = await db
    .update(PaymentInvoiceTable)
    .set({
      status: event.type,
      external_payment_id: event.externalPaymentID ?? invoice.external_payment_id,
      ...(event.type === "paid" ? { time_verified: occurredAt } : {}),
      ...(event.type === "failed" ? { time_failed: occurredAt } : {}),
      ...(event.type === "expired" ? { time_expired: occurredAt } : {}),
      ...(event.type === "cancelled" ? { time_cancelled: occurredAt } : {}),
      ...(event.type === "refunded" ? { time_refunded: occurredAt } : {}),
    })
    .where(and(eq(PaymentInvoiceTable.id, invoice.id), eq(PaymentInvoiceTable.status, invoice.status)))

  if (resultChanges(updated) !== 1) throw new Error("Payment invoice changed concurrently")

  const current = await requirePaymentInvoice(db, invoice.id)
  await effect?.({
    db,
    invoice: current,
    previousStatus: invoice.status,
    event,
  })
  return {
    kind: "applied" as const,
    outcome,
    invoice: current,
  }
}

export function applyPaymentEvent(input: ApplyPaymentEventInput, effect?: PaymentTransitionEffect) {
  return Database.transaction((db) => applyPaymentEventWithDb(db, input, effect))
}

export function paymentTransition(
  from: PaymentInvoiceStatus,
  to: (typeof PaymentEventTypes)[number],
): PaymentTransitionOutcome {
  if (from === to) return "noop"
  if (from === "created" && ["pending", "paid", "failed", "expired", "cancelled"].includes(to)) return "applied"
  if (from === "pending" && ["paid", "failed", "expired", "cancelled"].includes(to)) return "applied"
  if (["failed", "expired", "cancelled"].includes(from) && to === "paid") return "applied"
  if (from === "paid" && to === "refunded") return "applied"
  return "rejected"
}

function resultChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0
  if ("meta" in result && result.meta && typeof result.meta === "object" && "changes" in result.meta) {
    return Number(result.meta.changes ?? 0)
  }
  if ("changes" in result) return Number(result.changes ?? 0)
  return 0
}

async function findPaymentEvent(
  db: Database.TxOrDb,
  provider: (typeof PaymentProviders)[number],
  merchantAccountID: string,
  externalEventID: string,
) {
  return db
    .select()
    .from(PaymentEventTable)
    .where(
      and(
        eq(PaymentEventTable.provider, provider),
        eq(PaymentEventTable.merchant_account_id, merchantAccountID),
        eq(PaymentEventTable.external_event_id, externalEventID),
      ),
    )
    .then((rows) => rows[0])
}

async function requirePaymentInvoice(db: Database.TxOrDb, id: string) {
  const invoice = await db
    .select()
    .from(PaymentInvoiceTable)
    .where(eq(PaymentInvoiceTable.id, id))
    .then((rows) => rows[0])
  if (!invoice) throw new Error("Payment invoice disappeared")
  return invoice
}

function assertInvoiceReplay(
  stored: typeof PaymentInvoiceTable.$inferSelect,
  replay: z.infer<typeof RecordPaymentInvoiceSchema>,
) {
  const expiresAt = stored.time_expires?.getTime()
  if (
    stored.workspace_id !== replay.workspaceID ||
    stored.merchant_account_id !== replay.merchantAccountID ||
    stored.purpose !== replay.purpose ||
    stored.plan !== (replay.plan ?? null) ||
    stored.amount !== replay.amount ||
    stored.currency !== replay.currency ||
    expiresAt !== replay.expiresAt
  ) {
    throw new Error("Payment invoice replay conflicts with the stored invoice")
  }
}

function assertEventReplay(
  stored: typeof PaymentEventTable.$inferSelect,
  replay: z.infer<typeof ApplyPaymentEventSchema>,
) {
  if (
    stored.merchant_account_id !== replay.merchantAccountID ||
    stored.external_invoice_id !== replay.externalInvoiceID ||
    stored.external_payment_id !== (replay.externalPaymentID ?? null) ||
    stored.amount !== (replay.amount ?? null) ||
    stored.currency !== (replay.currency ?? null) ||
    stored.type !== replay.type ||
    stored.payload_hash !== replay.payloadHash ||
    stored.time_occurred.getTime() !== replay.occurredAt
  ) {
    throw new Error("Payment event replay conflicts with the stored event")
  }
}
