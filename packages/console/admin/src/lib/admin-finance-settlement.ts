import { z } from "zod"
import {
  and,
  Database,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  notExists,
} from "@mongolgpt/console-core/drizzle/index.js"
import { recordFinancePaymentSettlement } from "@mongolgpt/console-core/finance-settlement.js"
import { paymentBatchGuard } from "@mongolgpt/console-core/payment-ledger.js"
import { sha256Hex, stableJson } from "@mongolgpt/console-core/payment-provider.js"
import {
  FinancePaymentSettlementTable,
  PaymentEventTable,
  PaymentInvoiceTable,
} from "@mongolgpt/console-core/schema/billing.sql.js"
import { PlatformAdminTable } from "@mongolgpt/console-core/schema/admin.sql.js"
import { AdminAuthorizationError, adminAuditQuery, requirePlatformAdminPermission, writeAdminAudit } from "./admin-auth"
import type { PlatformAdminContext } from "./admin-context"
import { AdminMutationRequestError, requireSameOriginAdminMutation } from "./admin-mutation"

const invoiceID = z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/)
const reference = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
const amount = z
  .string()
  .regex(/^-?(0|[1-9]\d*)$/)
  .transform(Number)
  .refine(Number.isSafeInteger)
const settlementTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/)
  .transform((value, context) => {
    const local = (value.length === 16 ? `${value}:00` : value).replace(" ", "T")
    const instant = Date.parse(`${local}+08:00`)
    if (
      !Number.isFinite(instant) ||
      instant < 0 ||
      instant > Date.now() + 60_000 ||
      new Date(instant + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) !== local
    ) {
      context.addIssue({ code: "custom", message: "Тооцооны огноо, цаг буруу байна." })
      return z.NEVER
    }
    return instant
  })

export const AdminFinanceSettlementInput = z
  .object({
    invoiceID,
    kind: z.enum(["payment", "refund"]),
    externalSettlementID: reference,
    statementReference: reference,
    grossAmountMNT: amount,
    feeAmountMNT: amount,
    taxAmountMNT: amount,
    netAmountMNT: amount,
    effectiveAt: settlementTime,
    confirmation: z.literal("verified"),
  })
  .strict()

const defaults = { batch: Database.batch, recordFinancePaymentSettlement, writeAdminAudit }
export type AdminFinanceSettlementDependencies = typeof defaults

export async function getAdminFinanceSettlement(
  context: PlatformAdminContext,
  rawInvoiceID: string,
  dependencies: Pick<AdminFinanceSettlementDependencies, "batch"> = defaults,
) {
  const admin = requirePlatformAdminPermission(context, "billing.read")
  const id = invoiceID.parse(rawInvoiceID)
  const [invoices, settlements] = await dependencies.batch((db) => [
    db
      .select()
      .from(PaymentInvoiceTable)
      .where(and(eq(PaymentInvoiceTable.id, id), isNull(PaymentInvoiceTable.timeDeleted))),
    db
      .select()
      .from(FinancePaymentSettlementTable)
      .where(eq(FinancePaymentSettlementTable.payment_invoice_id, id))
      .orderBy(desc(FinancePaymentSettlementTable.time_effective)),
  ])
  const invoice = invoices[0]
  return {
    admin,
    canRecord: admin.permissions.includes("payments.settle"),
    invoice: invoice
      ? {
          id: invoice.id,
          provider: invoice.provider,
          merchantAccountID: invoice.merchant_account_id,
          externalInvoiceID: invoice.external_invoice_id,
          amount: invoice.amount,
          status: invoice.status,
        }
      : null,
    settlements: invoice
      ? settlements.map((item) => ({
          id: item.id,
          kind: item.kind,
          externalSettlementID: item.external_settlement_id,
          grossAmountMNT: item.gross_amount_mnt,
          feeAmountMNT: item.fee_amount_mnt,
          taxAmountMNT: item.tax_amount_mnt,
          netAmountMNT: item.net_amount_mnt,
          effectiveAt: item.time_effective.toISOString(),
          payloadHash: item.payload_hash,
        }))
      : [],
  }
}

export async function recordAdminFinanceSettlement(
  context: PlatformAdminContext,
  request: Request,
  raw: unknown,
  dependencies: AdminFinanceSettlementDependencies = defaults,
) {
  try {
    requireSameOriginAdminMutation(request)
    const admin = requirePlatformAdminPermission(context, "payments.settle")
    const input = AdminFinanceSettlementInput.parse(raw)
    const [invoices, events] = await dependencies.batch((db) => [
      db
        .select()
        .from(PaymentInvoiceTable)
        .where(and(eq(PaymentInvoiceTable.id, input.invoiceID), isNull(PaymentInvoiceTable.timeDeleted))),
      db
        .select()
        .from(PaymentEventTable)
        .where(
          and(
            eq(PaymentEventTable.invoice_id, input.invoiceID),
            eq(PaymentEventTable.type, input.kind === "payment" ? "paid" : "refunded"),
            eq(PaymentEventTable.outcome, "applied"),
            isNull(PaymentEventTable.timeDeleted),
          ),
        )
        .orderBy(desc(PaymentEventTable.timeCreated))
        .limit(1),
    ])
    const invoice = invoices[0]
    const event = events[0]
    if (!invoice || !event) throw new Error("Verified payment event not found")
    const payloadHash = await sha256Hex(stableJson({ version: 1, source: "admin_verified_statement", ...input }))
    const idempotencyKey = `statement:${await sha256Hex(stableJson([invoice.provider, invoice.merchant_account_id, input.externalSettlementID]))}`
    const result = await dependencies.recordFinancePaymentSettlement(
      {
        workspaceID: invoice.workspace_id,
        paymentInvoiceID: invoice.id,
        paymentEventID: event.id,
        provider: invoice.provider,
        merchantAccountID: invoice.merchant_account_id,
        externalSettlementID: input.externalSettlementID,
        kind: input.kind,
        grossAmountMNT: input.grossAmountMNT,
        feeAmountMNT: input.feeAmountMNT,
        taxAmountMNT: input.taxAmountMNT,
        netAmountMNT: input.netAmountMNT,
        currency: "MNT",
        effectiveAt: input.effectiveAt,
        idempotencyKey,
        payloadHash,
      },
      {
        batch: dependencies.batch,
        effect: (db, { settlement, replay }) => [
          // Permission and duplicate-kind guards share the settlement's atomic D1 commit.
          paymentBatchGuard(
            db,
            exists(
              db
                .select()
                .from(PlatformAdminTable)
                .where(
                  and(
                    eq(PlatformAdminTable.id, admin.id),
                    eq(PlatformAdminTable.email, admin.email),
                    eq(PlatformAdminTable.access_subject, admin.subject),
                    eq(PlatformAdminTable.status, "active"),
                    inArray(PlatformAdminTable.role, ["owner", "administrator"]),
                    isNull(PlatformAdminTable.timeDeleted),
                  ),
                ),
            ),
          ),
          paymentBatchGuard(
            db,
            notExists(
              db
                .select()
                .from(FinancePaymentSettlementTable)
                .where(
                  and(
                    eq(FinancePaymentSettlementTable.payment_invoice_id, invoice.id),
                    eq(FinancePaymentSettlementTable.kind, input.kind),
                    ne(FinancePaymentSettlementTable.id, settlement.id),
                  ),
                ),
            ),
          ),
          adminAuditQuery(db, {
            adminID: admin.id,
            actorEmail: admin.email,
            request,
            action: "payments.settle",
            outcome: "success",
            targetType: "payment_invoice",
            targetID: invoice.id,
            metadata: {
              settlement_id: settlement.id,
              statement_reference: input.statementReference,
              payload_hash: payloadHash,
              replay,
            },
          }),
        ],
      },
    )
    return {
      ok: true as const,
      message:
        result.kind === "duplicate"
          ? "Энэ тооцоо өмнө нь бүртгэгдсэн байна. Давхар орлого, зардал нэмээгүй."
          : "Баталгаажуулсан тооцоо, шимтгэл, татварыг үйлдлийн бүртгэлтэй нь хадгаллаа.",
    }
  } catch (error) {
    const denied =
      error instanceof AdminAuthorizationError ||
      error instanceof AdminMutationRequestError ||
      error instanceof z.ZodError
    try {
      await dependencies.writeAdminAudit({
        adminID: context.id,
        actorEmail: context.email,
        request,
        action: "payments.settle",
        outcome: denied ? "denied" : "failure",
        metadata: { reason: denied ? "invalid_request" : "settlement_not_confirmed" },
      })
    } catch {
      return {
        ok: false as const,
        message: "Үйлдлийг баталгаажуулж чадсангүй. Тооцооны бүртгэлээ шинэчилж шалгаад давтан оролдоно уу.",
      }
    }
    return {
      ok: false as const,
      message:
        error instanceof AdminAuthorizationError
          ? error.message
          : error instanceof z.ZodError && error.issues.some((issue) => issue.path[0] === "netAmountMNT")
            ? "Нийт дүнгээс шимтгэл, татварыг хассан дүн цэвэр дүнтэй тэнцэхгүй байна. Эх баримттай тулган засна уу."
            : denied
              ? "Тооцооны хүсэлт буруу эсвэл аюулгүй байдлын шалгалт хангаагүй байна."
              : "Тооцоог баталгаажуулж чадсангүй. Дүн, давхардал, нэхэмжлэхийн төлөвийг бүртгэлтэй тулган шалгана уу.",
    }
  }
}
