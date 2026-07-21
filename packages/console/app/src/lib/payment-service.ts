import {
  SubscriptionCheckoutRequestSchema,
  SubscriptionCheckoutResultSchema,
  type SubscriptionCheckoutRequest,
} from "@mongolgpt/console-core/payment-checkout-contract.js"
import { z } from "zod"

const PaymentServiceErrorSchema = z
  .object({
    error: z.string().trim().min(1).max(512),
    code: z.string().trim().min(1).max(64).optional(),
    invoiceID: z.string().trim().min(1).max(64).optional(),
  })
  .passthrough()

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class PaymentServiceClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly invoiceID?: string,
  ) {
    super(message)
    this.name = "PaymentServiceClientError"
  }
}

export function createPaymentServiceClient(input: { fetcher: Fetcher; token: string }) {
  const token = z.string().min(16).max(4_096).parse(input.token)
  return {
    async createSubscriptionCheckout(request: SubscriptionCheckoutRequest) {
      const body = SubscriptionCheckoutRequestSchema.parse(request)
      let response: Response
      try {
        response = await input.fetcher("https://payments.internal/v1/checkouts/subscription", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        })
      } catch {
        throw new PaymentServiceClientError(503, "Төлбөрийн үйлчилгээтэй холбогдож чадсангүй.")
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new PaymentServiceClientError(502, "Төлбөрийн үйлчилгээ буруу хариу буцаалаа.")
      }
      if (!response.ok) {
        const error = PaymentServiceErrorSchema.safeParse(payload)
        if (!error.success) {
          throw new PaymentServiceClientError(response.status, "Төлбөрийн хүсэлт амжилтгүй боллоо.")
        }
        throw new PaymentServiceClientError(response.status, error.data.error, error.data.code, error.data.invoiceID)
      }

      const checkout = SubscriptionCheckoutResultSchema.safeParse(payload)
      if (!checkout.success) {
        throw new PaymentServiceClientError(502, "Төлбөрийн үйлчилгээ буруу хариу буцаалаа.")
      }
      return checkout.data
    },
  }
}
