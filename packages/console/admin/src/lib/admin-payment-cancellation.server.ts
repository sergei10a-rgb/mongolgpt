import { Resource } from "@mongolgpt/console-resource"
import {
  PlatformAdminSubscriptionCheckoutCancellationRequestSchema,
  SubscriptionCheckoutCancellationResultSchema,
  type PlatformAdminSubscriptionCheckoutCancellationRequest,
} from "@mongolgpt/console-core/payment-cancellation-contract.js"
import { z } from "zod"

const PaymentServiceErrorSchema = z
  .object({
    error: z.string().trim().min(1).max(512),
    code: z.string().trim().min(1).max(64).optional(),
  })
  .passthrough()

export class AdminPaymentCancellationServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = "AdminPaymentCancellationServiceError"
  }
}

export async function requestPlatformAdminSubscriptionCheckoutCancellation(
  input: PlatformAdminSubscriptionCheckoutCancellationRequest,
) {
  "use server"
  const body = PlatformAdminSubscriptionCheckoutCancellationRequestSchema.parse(input)
  let response: Response
  try {
    response = await Resource.PaymentService.fetch("https://payments.internal/v1/admin/checkouts/subscription/cancel", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Resource.AdminPaymentCancellationToken.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new AdminPaymentCancellationServiceError(503, "Төлбөрийн үйлчилгээтэй холбогдож чадсангүй.")
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new AdminPaymentCancellationServiceError(502, "Төлбөрийн үйлчилгээ буруу хариу буцаалаа.")
  }
  if (!response.ok) {
    const error = PaymentServiceErrorSchema.safeParse(payload)
    if (!error.success) {
      throw new AdminPaymentCancellationServiceError(response.status, "Цуцлах хүсэлт амжилтгүй боллоо.")
    }
    throw new AdminPaymentCancellationServiceError(response.status, error.data.error, error.data.code)
  }

  const result = SubscriptionCheckoutCancellationResultSchema.safeParse(payload)
  if (!result.success) {
    throw new AdminPaymentCancellationServiceError(502, "Төлбөрийн үйлчилгээ буруу хариу буцаалаа.")
  }
  return result.data
}
