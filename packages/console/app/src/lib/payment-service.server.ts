import type { SubscriptionCheckoutRequest } from "@mongolgpt/console-core/payment-checkout-contract.js"
import type { SubscriptionCheckoutCancellationRequest } from "@mongolgpt/console-core/payment-cancellation-contract.js"
import { Resource } from "@mongolgpt/console-resource"
import { createPaymentServiceClient } from "./payment-service"

export function requestSubscriptionCheckout(input: SubscriptionCheckoutRequest) {
  "use server"
  return createPaymentServiceClient({
    fetcher: (request, init) => Resource.PaymentService.fetch(request, init),
    token: Resource.PaymentServiceToken.value,
  }).createSubscriptionCheckout(input)
}

export function requestSubscriptionCheckoutCancellation(input: SubscriptionCheckoutCancellationRequest) {
  "use server"
  return createPaymentServiceClient({
    fetcher: (request, init) => Resource.PaymentService.fetch(request, init),
    token: Resource.PaymentServiceToken.value,
  }).cancelSubscriptionCheckout(input)
}
