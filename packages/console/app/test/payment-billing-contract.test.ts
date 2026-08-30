import { describe, expect, test } from "bun:test"

const subscriptionSource = await Bun.file(
  new URL("../src/routes/workspace/[id]/billing/subscription-section.tsx", import.meta.url),
).text()
const paymentSource = await Bun.file(
  new URL("../src/routes/workspace/[id]/billing/payment-section.tsx", import.meta.url),
).text()

describe("workspace payment billing contract", () => {
  test("rotates the checkout idempotency key only after a successful cancellation", () => {
    expect(subscriptionSource).toContain("const result = await cancelCheckout(params.id!, invoiceID, request.key)")
    expect(subscriptionSource).toContain('if (result.ok) setRequestKey("")')
    expect(subscriptionSource.indexOf('if (result.ok) setRequestKey("")')).toBeGreaterThan(
      subscriptionSource.indexOf("await cancelCheckout"),
    )
  })

  test("keeps checkout creation and cancellation bound to the authenticated workspace administrator", () => {
    expect(subscriptionSource).toContain("Actor.assertAdmin()")
    expect(subscriptionSource).toContain("workspaceID: Actor.workspace()")
    expect(subscriptionSource).toContain("accountID: actor.properties.accountID")
    expect(subscriptionSource).toContain("SubscriptionCheckoutRequestSchema.safeParse")
    expect(subscriptionSource).toContain("SubscriptionCheckoutCancellationRequestSchema.safeParse")
  })

  test("shows the authoritative terminal timestamp for expired and cancelled invoices", () => {
    expect(paymentSource).toContain("props.payment.cancelledAt")
    expect(paymentSource).toContain("props.payment.expiredAt")
    expect(paymentSource.indexOf("props.payment.cancelledAt")).toBeLessThan(
      paymentSource.indexOf("props.payment.createdAt"),
    )
    expect(paymentSource.indexOf("props.payment.expiredAt")).toBeLessThan(paymentSource.indexOf("props.payment.createdAt"))
  })
})
