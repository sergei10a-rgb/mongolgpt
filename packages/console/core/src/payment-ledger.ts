import { and, Database, eq, exists, isNull, notExists, sql, type SQL } from "./drizzle"
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
    createdAt: timestamp.optional(),
    expiresAt: timestamp.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.purpose === "subscription" && !input.plan) {
      context.addIssue({
        code: "custom",
        path: ["plan"],
        message: "Захиалгын нэхэмжлэхэд багц шаардлагатай",
      })
    }
    if (input.purpose === "credit" && input.plan) {
      context.addIssue({
        code: "custom",
        path: ["plan"],
        message: "Кредит нэхэмжлэл дотор багц байж болохгүй",
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
        message: `${input.type} үйл явдалд гадаад төлбөрийн ID шаардлагатай`,
      })
    }
    if (settlement && input.amount === undefined) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: `${input.type} үйл явдалд дүн шаардлагатай`,
      })
    }
    if (settlement && input.currency === undefined) {
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: `${input.type} үйл явдалд валют шаардлагатай`,
      })
    }
    if ((input.amount === undefined) !== (input.currency === undefined)) {
      context.addIssue({
        code: "custom",
        path: input.amount === undefined ? ["amount"] : ["currency"],
        message: "Төлбөрийн үйл явдлын дүн болон валютыг хамтад нь өгнө",
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

export type PaymentBatchDatabase = Parameters<Parameters<typeof Database.batch>[0]>[0]
export type PaymentBatchQuery = Parameters<PaymentBatchDatabase["batch"]>[0][number]
export type PaymentTransitionBatchEffect = (input: {
  db: PaymentBatchDatabase
  invoice: typeof PaymentInvoiceTable.$inferSelect
  previousStatus: PaymentInvoiceStatus
  event: z.output<typeof ApplyPaymentEventSchema>
}) => readonly PaymentBatchQuery[]

// SQLite RAISE is trigger-only. A deliberately invalid JSON value aborts the entire D1
// batch when a checked snapshot or business precondition is no longer true.
export function paymentBatchGuard(db: PaymentBatchDatabase, condition: SQL | undefined) {
  if (!condition) throw new TypeError("Төлбөрийн багц үйлдлийн шалгах нөхцөл алга")
  return db
    .select({
      valid: sql<number>`case when ${condition} then 1 else json_extract('mongolgpt_payment_state_conflict', '$') end`,
    })
    .from(sql`(select 1)`)
}

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
      timeCreated: invoice.createdAt === undefined ? undefined : new Date(invoice.createdAt),
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
  if (!stored) throw new Error("Төлбөрийн нэхэмжлэх нэмэгдсэнгүй")

  if (resultChanges(inserted) === 0) {
    assertInvoiceReplay(stored, invoice)
    return { kind: "duplicate" as const, invoice: stored }
  }
  return { kind: "created" as const, invoice: stored }
}

export async function recordPaymentInvoice(
  input: RecordPaymentInvoiceInput,
  dependencies: { batch?: typeof Database.batch } = {},
) {
  const invoice = RecordPaymentInvoiceSchema.parse(input)
  const [inserted, rows] = await (dependencies.batch ?? Database.batch)(
    (db) =>
      [
        db
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
            timeCreated: invoice.createdAt === undefined ? undefined : new Date(invoice.createdAt),
            time_expires: invoice.expiresAt === undefined ? undefined : new Date(invoice.expiresAt),
          })
          .onConflictDoNothing()
          .returning(),
        db
          .select()
          .from(PaymentInvoiceTable)
          .where(
            and(
              eq(PaymentInvoiceTable.provider, invoice.provider),
              eq(PaymentInvoiceTable.merchant_account_id, invoice.merchantAccountID),
              eq(PaymentInvoiceTable.external_invoice_id, invoice.externalInvoiceID),
            ),
          )
          .limit(1),
      ] as const,
  )
  const stored = rows[0]
  if (!stored || stored.timeDeleted) throw new Error("Төлбөрийн нэхэмжлэх олдсонгүй")
  if (inserted.length) return { kind: "created" as const, invoice: stored }
  assertInvoiceReplay(stored, invoice)
  return { kind: "duplicate" as const, invoice: stored }
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
  if (!invoice) throw new Error("Төлбөрийн нэхэмжлэх олдсонгүй")
  if (
    invoice.external_payment_id &&
    event.externalPaymentID &&
    invoice.external_payment_id !== event.externalPaymentID
  ) {
    throw new Error("Төлбөрийн үйл явдал өөр гадаад төлбөрийг зааж байна")
  }
  if (event.amount !== undefined && (event.amount !== invoice.amount || event.currency !== invoice.currency)) {
    throw new Error("Төлбөрийн үйл явдлын дүн эсвэл валют нэхэмжлэхтэй таарахгүй байна")
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
    if (!concurrent) throw new Error("Төлбөрийн үйл явдлын давхардлын зөрчил гарлаа")
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

  if (resultChanges(updated) !== 1) throw new Error("Төлбөрийн нэхэмжлэх зэрэг өөрчлөгдсөн байна")

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

export async function applyPaymentEvent(
  input: ApplyPaymentEventInput,
  effect?: PaymentTransitionBatchEffect,
  dependencies: { batch?: typeof Database.batch } = {},
) {
  const event = ApplyPaymentEventSchema.parse(input)
  const batch = dependencies.batch ?? Database.batch
  const scope = and(
    eq(PaymentInvoiceTable.provider, event.provider),
    eq(PaymentInvoiceTable.merchant_account_id, event.merchantAccountID),
    eq(PaymentInvoiceTable.external_invoice_id, event.externalInvoiceID),
    isNull(PaymentInvoiceTable.timeDeleted),
  )
  const eventScope = and(
    eq(PaymentEventTable.provider, event.provider),
    eq(PaymentEventTable.merchant_account_id, event.merchantAccountID),
    eq(PaymentEventTable.external_event_id, event.externalEventID),
  )
  const [invoices, replays] = await batch(
    (db) =>
      [
        db.select().from(PaymentInvoiceTable).where(scope).limit(1),
        db.select().from(PaymentEventTable).where(eventScope).limit(1),
      ] as const,
  )
  const invoice = invoices[0]
  if (!invoice) throw new Error("Төлбөрийн нэхэмжлэх олдсонгүй")
  if (invoice.external_payment_id && event.externalPaymentID && invoice.external_payment_id !== event.externalPaymentID)
    throw new Error("Төлбөрийн үйл явдал өөр гадаад төлбөрийг зааж байна")
  if (event.amount !== undefined && (event.amount !== invoice.amount || event.currency !== invoice.currency))
    throw new Error("Төлбөрийн үйл явдлын дүн эсвэл валют нэхэмжлэхтэй таарахгүй байна")
  const replay = replays[0]
  if (replay) {
    assertEventReplay(replay, event)
    return { kind: "duplicate" as const, outcome: replay.outcome, invoice }
  }
  const outcome = paymentTransition(invoice.status, event.type)
  const result = await batch((db) => {
    const current = db
      .select({ id: PaymentInvoiceTable.id })
      .from(PaymentInvoiceTable)
      .where(
        and(
          scope,
          eq(PaymentInvoiceTable.id, invoice.id),
          eq(PaymentInvoiceTable.workspace_id, invoice.workspace_id),
          eq(PaymentInvoiceTable.status, invoice.status),
          eq(PaymentInvoiceTable.purpose, invoice.purpose),
          invoice.plan === null ? isNull(PaymentInvoiceTable.plan) : eq(PaymentInvoiceTable.plan, invoice.plan),
          eq(PaymentInvoiceTable.amount, invoice.amount),
          eq(PaymentInvoiceTable.currency, invoice.currency),
          invoice.external_payment_id === null
            ? isNull(PaymentInvoiceTable.external_payment_id)
            : eq(PaymentInvoiceTable.external_payment_id, invoice.external_payment_id),
        ),
      )
    const occurredAt = new Date(event.occurredAt)
    const changes = {
      status: event.type,
      external_payment_id: event.externalPaymentID ?? invoice.external_payment_id,
      timeUpdated: new Date(),
      ...(event.type === "paid" ? { time_verified: occurredAt } : {}),
      ...(event.type === "failed" ? { time_failed: occurredAt } : {}),
      ...(event.type === "expired" ? { time_expired: occurredAt } : {}),
      ...(event.type === "cancelled" ? { time_cancelled: occurredAt } : {}),
      ...(event.type === "refunded" ? { time_refunded: occurredAt } : {}),
    }
    const applied: readonly PaymentBatchQuery[] =
      outcome === "applied"
        ? [
            db.update(PaymentInvoiceTable).set(changes).where(eq(PaymentInvoiceTable.id, invoice.id)),
            ...(effect?.({
              db,
              invoice: { ...invoice, ...changes },
              previousStatus: invoice.status,
              event,
            }) ?? []),
          ]
        : []
    return [
      paymentBatchGuard(
        db,
        and(
          exists(current),
          notExists(db.select({ id: PaymentEventTable.id }).from(PaymentEventTable).where(eventScope)),
        ),
      ),
      db.insert(PaymentEventTable).values({
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
        time_occurred: occurredAt,
      }),
      ...applied,
      db.select().from(PaymentInvoiceTable).where(eq(PaymentInvoiceTable.id, invoice.id)).limit(1),
    ] as const
  })
  const rows = result.at(-1) as (typeof PaymentInvoiceTable.$inferSelect)[]
  if (!rows[0]) throw new Error("Төлбөрийн нэхэмжлэх олдсонгүй")
  return { kind: outcome, outcome, invoice: rows[0] }
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
  if (!invoice) throw new Error("Төлбөрийн нэхэмжлэх олдсонгүй")
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
    (replay.createdAt !== undefined && stored.timeCreated.getTime() !== replay.createdAt) ||
    expiresAt !== replay.expiresAt
  ) {
    throw new Error("Төлбөрийн нэхэмжлэх хүсэлтийг дахин илгээхэд хадгалсан нэхэмжлэхтэй зөрчилдөж байна")
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
    throw new Error("Төлбөрийн үйл явдлыг дахин илгээхэд хадгалсан үйл явдалтай зөрчилдөж байна")
  }
}
