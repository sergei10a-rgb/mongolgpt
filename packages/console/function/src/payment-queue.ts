import {
  PaymentQueueEventSchema,
  applyPaymentQueueEvent,
  type PaymentQueueEvent,
} from "@mongolgpt/console-core/payment-queue.js"
import { applyPlanSubscriptionPaymentEffect } from "@mongolgpt/console-core/payment-entitlement.js"
import { deactivatePlanQuota } from "./quota-client"

type ApplyPayment = (event: PaymentQueueEvent) => Promise<unknown>
type PaymentApplyResult = {
  kind: string
  invoice: {
    id: string
    workspace_id: string
    status: string
    purpose: string
  }
}
type ApplyPaymentLedger = (event: PaymentQueueEvent) => Promise<PaymentApplyResult>
type DeactivatePlanQuota = (workspaceID: string, invoiceID: string) => Promise<void>
type QueueBatch = {
  messages: ReadonlyArray<{
    body: unknown
    ack(): void
    retry(): void
  }>
}

export function createPaymentEntitlementApply(
  apply: ApplyPaymentLedger = (event) => applyPaymentQueueEvent(event, applyPlanSubscriptionPaymentEffect),
  deactivate: DeactivatePlanQuota = deactivatePlanQuota,
): ApplyPayment {
  return async (event) => {
    const result = await apply(event)
    if (
      event.event.type === "refunded" &&
      result.invoice.status === "refunded" &&
      result.invoice.purpose === "subscription"
    ) {
      await deactivate(result.invoice.workspace_id, result.invoice.id)
    }
    return result
  }
}

const applyPaymentWithEntitlements = createPaymentEntitlementApply()

export function createPaymentQueueConsumer(apply: ApplyPayment = applyPaymentWithEntitlements) {
  return {
    async queue(batch: QueueBatch) {
      for (const message of batch.messages) {
        const parsed = PaymentQueueEventSchema.safeParse(message.body)
        if (!parsed.success) {
          console.error("Payment queue message validation failed")
          message.retry()
          continue
        }

        try {
          await apply(parsed.data)
          message.ack()
        } catch (error) {
          console.error("Payment queue event failed", {
            provider: parsed.data.event.provider,
            externalEventID: parsed.data.event.externalEventID,
            error: error instanceof Error ? error.name : typeof error,
          })
          message.retry()
        }
      }
    },
  }
}

export default createPaymentQueueConsumer()
