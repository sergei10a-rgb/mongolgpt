import { PaymentInvoiceCheckoutSchema } from "./payment-provider-contract"
import { PaymentCheckoutStatuses, PaymentProviders, PlanNames } from "./schema/billing.sql"
import { z } from "zod"

const internalIdentifier = z.string().trim().min(5).max(30)

export const PaymentPlanCatalogSchema = z
  .object({
    basic: planPriceSchema(),
    pro: planPriceSchema(),
    max: planPriceSchema(),
  })
  .strict()

export const SubscriptionCheckoutRequestSchema = z
  .object({
    workspaceID: internalIdentifier.regex(/^wrk_/),
    accountID: internalIdentifier.regex(/^acc_/),
    requestKey: z.string().trim().uuid().max(64),
    provider: z.enum(PaymentProviders),
    plan: z.enum(PlanNames),
  })
  .strict()

export const SubscriptionCheckoutResultSchema = z
  .object({
    invoiceID: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/),
    status: z.literal("ready"),
    provider: z.enum(PaymentProviders),
    plan: z.enum(PlanNames),
    amount: z.number().int().positive(),
    currency: z.literal("MNT"),
    expiresAt: z.number().int().nonnegative(),
    checkout: PaymentInvoiceCheckoutSchema,
  })
  .strict()

export const SubscriptionBillingOverviewSchema = z
  .object({
    subscription: z
      .object({
        id: internalIdentifier,
        plan: z.enum(PlanNames),
        status: z.literal("active"),
        periodStart: z.number().int().nonnegative(),
        periodEnd: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    checkout: z
      .object({
        invoiceID: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/),
        status: z.enum(PaymentCheckoutStatuses),
        provider: z.enum(PaymentProviders),
        plan: z.enum(PlanNames),
        amount: z.number().int().positive(),
        currency: z.literal("MNT"),
        createdAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().nonnegative(),
        checkout: PaymentInvoiceCheckoutSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()

export type PaymentPlanCatalog = z.input<typeof PaymentPlanCatalogSchema>
export type SubscriptionCheckoutRequest = z.input<typeof SubscriptionCheckoutRequestSchema>
export type SubscriptionCheckoutResult = z.output<typeof SubscriptionCheckoutResultSchema>
export type SubscriptionBillingOverview = z.output<typeof SubscriptionBillingOverviewSchema>

function planPriceSchema() {
  return z
    .object({
      label: z.string().trim().min(1).max(64),
      amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict()
}
