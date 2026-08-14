import { PaymentCancellationStatuses, PaymentProviders } from "./schema/billing.sql"
import { z } from "zod"

const internalIdentifier = z.string().trim().min(5).max(30)

export const SubscriptionCheckoutCancellationRequestSchema = z
  .object({
    workspaceID: internalIdentifier.regex(/^wrk_/),
    accountID: internalIdentifier.regex(/^acc_/),
    invoiceID: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/),
    requestKey: z.string().trim().uuid().max(64),
  })
  .strict()

const mongolianOperatorReason = z
  .string()
  .trim()
  .min(20)
  .max(500)
  .refine((value) => /\p{Script=Cyrillic}/u.test(value), "Operator reason must be written in Mongolian")

export const PlatformAdminSubscriptionCheckoutCancellationRequestSchema = z
  .object({
    invoiceID: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/),
    requestKey: z.string().trim().uuid().max(64),
    reason: mongolianOperatorReason,
  })
  .strict()

export const SubscriptionCheckoutCancellationResultSchema = z
  .object({
    invoiceID: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/),
    provider: z.enum(PaymentProviders),
    status: z.literal("cancelled"),
  })
  .strict()

export const PaymentCancellationStateSchema = z
  .object({
    status: z.enum(PaymentCancellationStatuses),
    errorCode: z.string().trim().min(1).max(64).nullable(),
  })
  .strict()

export type SubscriptionCheckoutCancellationRequest = z.input<typeof SubscriptionCheckoutCancellationRequestSchema>
export type PlatformAdminSubscriptionCheckoutCancellationRequest = z.input<
  typeof PlatformAdminSubscriptionCheckoutCancellationRequestSchema
>
export type SubscriptionCheckoutCancellationResult = z.output<typeof SubscriptionCheckoutCancellationResultSchema>
export type PaymentCancellationState = z.output<typeof PaymentCancellationStateSchema>
