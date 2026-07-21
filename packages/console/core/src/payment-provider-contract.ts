import { PaymentProviders } from "./schema/billing.sql"
import { z } from "zod"

const httpsURL = z
  .url()
  .max(255)
  .refine((value) => new URL(value).protocol === "https:", "Payment checkout URL must use HTTPS")

const paymentDeepLink = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol.toLowerCase()
    return !["http:", "javascript:", "data:", "vbscript:", "file:", "blob:"].includes(protocol)
  }, "Payment deep link uses an unsafe protocol")

export const PaymentInvoiceRequestSchema = z
  .object({
    reference: z.string().trim().min(1).max(45),
    customerReference: z.string().trim().min(1).max(45),
    description: z.string().trim().min(1).max(255),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("MNT"),
    expiresAt: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
  })
  .strict()

export const PaymentDeepLinkSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(255).default(""),
    link: paymentDeepLink,
  })
  .strict()

export const PaymentInvoiceCheckoutSchema = z
  .object({
    provider: z.enum(PaymentProviders),
    merchantAccountID: z.string().trim().min(1).max(255),
    externalInvoiceID: z.string().trim().min(1).max(255),
    qrText: z.string().max(32_768).optional(),
    qrImage: z.string().max(2_000_000).optional(),
    checkoutURL: httpsURL.optional(),
    deepLinks: z.array(PaymentDeepLinkSchema).max(64).default([]),
  })
  .strict()

export const PaymentReconciliationRequestSchema = z
  .object({
    externalInvoiceID: z.string().trim().min(1).max(255),
    expectedAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("MNT"),
    callbackPaymentID: z.string().trim().min(1).max(255).optional(),
  })
  .strict()

export const PaymentInvoiceCancellationRequestSchema = z
  .object({
    externalInvoiceID: z.string().trim().min(1).max(255),
  })
  .strict()

export const PaymentInvoiceCancellationReceiptSchema = z
  .object({
    provider: z.enum(PaymentProviders),
    merchantAccountID: z.string().trim().min(1).max(255),
    externalInvoiceID: z.string().trim().min(1).max(255),
  })
  .strict()

export const MNTAmountSchema = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^\d+(?:\.0+)?$/),
  ])
  .transform((value, context) => {
    const amount = typeof value === "number" ? value : Number(value.split(".", 1)[0])
    if (!Number.isSafeInteger(amount) || amount < 0) {
      context.addIssue({ code: "custom", message: "Payment provider returned an invalid MNT amount" })
      return z.NEVER
    }
    return amount
  })

export type PaymentInvoiceRequest = z.input<typeof PaymentInvoiceRequestSchema>
export type PaymentInvoiceCheckout = z.output<typeof PaymentInvoiceCheckoutSchema>
export type PaymentReconciliationRequest = z.input<typeof PaymentReconciliationRequestSchema>
export type PaymentInvoiceCancellationRequest = z.input<typeof PaymentInvoiceCancellationRequestSchema>
export type PaymentInvoiceCancellationReceipt = z.output<typeof PaymentInvoiceCancellationReceiptSchema>
