import { and, Database, desc, eq, isNull } from "./drizzle"
import {
  PaymentInvoiceStatuses,
  PaymentInvoiceTable,
  PaymentProviders,
  PaymentPurposes,
  PlanNames,
} from "./schema/billing.sql"
import { z } from "zod"

const workspaceIdentifier = z.string().trim().min(5).max(30).regex(/^wrk_/)
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const historyLimit = z.number().int().min(1).max(50)

export const WorkspacePaymentHistoryItemSchema = z
  .object({
    invoiceID: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/),
    provider: z.enum(PaymentProviders),
    purpose: z.enum(PaymentPurposes),
    plan: z.enum(PlanNames).nullable(),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("MNT"),
    status: z.enum(PaymentInvoiceStatuses),
    createdAt: timestamp,
    expiresAt: timestamp.nullable(),
    verifiedAt: timestamp.nullable(),
    refundedAt: timestamp.nullable(),
  })
  .strict()

export const WorkspacePaymentHistorySchema = z.array(WorkspacePaymentHistoryItemSchema).max(50)

export type WorkspacePaymentHistoryItem = z.output<typeof WorkspacePaymentHistoryItemSchema>

export function getWorkspacePaymentHistory(workspaceID: string, limit = 25) {
  return Database.use((db) => getWorkspacePaymentHistoryWithDb(db, workspaceID, limit))
}

export async function getWorkspacePaymentHistoryWithDb(db: Database.TxOrDb, workspaceID: string, limit = 25) {
  const workspace = workspaceIdentifier.parse(workspaceID)
  const boundedLimit = historyLimit.parse(limit)
  const rows = await db
    .select({
      invoiceID: PaymentInvoiceTable.id,
      provider: PaymentInvoiceTable.provider,
      purpose: PaymentInvoiceTable.purpose,
      plan: PaymentInvoiceTable.plan,
      amount: PaymentInvoiceTable.amount,
      currency: PaymentInvoiceTable.currency,
      status: PaymentInvoiceTable.status,
      createdAt: PaymentInvoiceTable.timeCreated,
      expiresAt: PaymentInvoiceTable.time_expires,
      verifiedAt: PaymentInvoiceTable.time_verified,
      refundedAt: PaymentInvoiceTable.time_refunded,
    })
    .from(PaymentInvoiceTable)
    .where(and(eq(PaymentInvoiceTable.workspace_id, workspace), isNull(PaymentInvoiceTable.timeDeleted)))
    .orderBy(desc(PaymentInvoiceTable.timeCreated), desc(PaymentInvoiceTable.id))
    .limit(boundedLimit)

  return WorkspacePaymentHistorySchema.parse(
    rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt?.getTime() ?? null,
      verifiedAt: row.verifiedAt?.getTime() ?? null,
      refundedAt: row.refundedAt?.getTime() ?? null,
    })),
  )
}
