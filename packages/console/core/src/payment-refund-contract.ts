import { PaymentProviders, PaymentRefundStatuses } from "./schema/billing.sql"
import { z } from "zod"

const mongolianOperatorReason = z
  .string()
  .trim()
  .min(20)
  .max(500)
  .refine((value) => /\p{Script=Cyrillic}/u.test(value), "Operator reason must be written in Mongolian")

export const PlatformAdminSubscriptionPaymentRefundRequestSchema = z
  .object({
    invoiceID: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/),
    requestKey: z.string().trim().uuid().max(64),
    reason: mongolianOperatorReason,
  })
  .strict()

export const SubscriptionPaymentRefundResultSchema = z
  .object({
    invoiceID: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/),
    provider: z.enum(PaymentProviders),
    status: z.literal("refunded"),
  })
  .strict()

export const PaymentRefundStateSchema = z
  .object({
    status: z.enum(PaymentRefundStatuses),
    errorCode: z.string().trim().min(1).max(64).nullable(),
  })
  .strict()

export type PlatformAdminSubscriptionPaymentRefundRequest = z.input<
  typeof PlatformAdminSubscriptionPaymentRefundRequestSchema
>
export type SubscriptionPaymentRefundResult = z.output<typeof SubscriptionPaymentRefundResultSchema>
export type PaymentRefundState = z.output<typeof PaymentRefundStateSchema>
