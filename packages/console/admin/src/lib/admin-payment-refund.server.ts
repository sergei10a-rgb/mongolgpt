import { Resource } from "@mongolgpt/console-resource"
import {
  PlatformAdminSubscriptionPaymentRefundRequestSchema,
  SubscriptionPaymentRefundResultSchema,
  type PlatformAdminSubscriptionPaymentRefundRequest,
} from "@mongolgpt/console-core/payment-refund-contract.js"
import { z } from "zod"

const PaymentServiceErrorSchema = z
  .object({
    error: z.string().trim().min(1).max(512),
    code: z.string().trim().min(1).max(64).optional(),
  })
  .passthrough()

export class AdminPaymentRefundServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = "AdminPaymentRefundServiceError"
  }
}

export async function requestPlatformAdminSubscriptionPaymentRefund(
  input: PlatformAdminSubscriptionPaymentRefundRequest,
) {
  "use server"
  const body = PlatformAdminSubscriptionPaymentRefundRequestSchema.parse(input)
  let response: Response
  try {
    response = await Resource.PaymentService.fetch("https://payments.internal/v1/admin/payments/subscription/refund", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Resource.AdminPaymentRefundToken.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new AdminPaymentRefundServiceError(503, "Төлбөрийн үйлчилгээтэй холбогдож чадсангүй.")
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new AdminPaymentRefundServiceError(502, "Төлбөрийн үйлчилгээ буруу хариу буцаалаа.")
  }
  if (!response.ok) {
    const error = PaymentServiceErrorSchema.safeParse(payload)
    if (!error.success) {
      throw new AdminPaymentRefundServiceError(response.status, "Буцаалтын хүсэлт амжилтгүй боллоо.")
    }
    throw new AdminPaymentRefundServiceError(response.status, error.data.error, error.data.code)
  }

  const result = SubscriptionPaymentRefundResultSchema.safeParse(payload)
  if (!result.success) {
    throw new AdminPaymentRefundServiceError(502, "Төлбөрийн үйлчилгээ буруу хариу буцаалаа.")
  }
  return result.data
}
