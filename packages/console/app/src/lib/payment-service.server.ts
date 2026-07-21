import type { SubscriptionCheckoutRequest } from "@mongolgpt/console-core/payment-checkout-contract.js"
import { Resource } from "@mongolgpt/console-resource"
import { createPaymentServiceClient } from "./payment-service"

export function requestSubscriptionCheckout(input: SubscriptionCheckoutRequest) {
  "use server"
  return createPaymentServiceClient({
    fetcher: (request, init) => Resource.PaymentService.fetch(request, init),
    token: Resource.PaymentServiceToken.value,
  }).createSubscriptionCheckout(input)
}
