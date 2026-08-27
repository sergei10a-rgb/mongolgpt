import { describe, expect, test } from "bun:test"
import { redactSecrets, runPaymentSandboxSmoke, type PaymentSandboxSmokeInput } from "../script/payment-sandbox-smoke"
import type { PaymentInvoiceCheckout, VerifiedPaymentEvent } from "../src/payment-provider"

const callbackBaseURL = "https://pay.dev.mgpt.mn"
const confirmation = "RUN_SANDBOX_SMOKE"

function checkout(provider: "qpay" | "bonum", id: string): PaymentInvoiceCheckout {
  return provider === "qpay"
    ? { provider, merchantAccountID: "test", externalInvoiceID: id, qrText: "qr", qrImage: "image", deepLinks: [] }
    : {
        provider,
        merchantAccountID: "test",
        externalInvoiceID: id,
        checkoutURL: `https://ecommerce.bonum.mn/ecommerce?invoiceId=${id}`,
        deepLinks: [],
      }
}

function pending(id: string): VerifiedPaymentEvent {
  return {
    provider: "qpay",
    merchantAccountID: "test",
    externalEventID: "event",
    externalInvoiceID: id,
    type: "pending",
    payloadHash: "hash",
    occurredAt: 0,
  }
}

function input(overrides: Partial<PaymentSandboxSmokeInput> = {}): PaymentSandboxSmokeInput {
  return {
    confirmation,
    environment: "sandbox",
    provider: "all",
    callbackBaseURL,
    reference: "test-smoke",
    now: () => 1_000,
    output: () => undefined,
    ...overrides,
  }
}

describe("payment sandbox smoke", () => {
  test("does not call adapters without explicit confirmation or in production", async () => {
    let calls = 0
    const qpay = {
      createInvoice: async () => {
        calls++
        return checkout("qpay", "q-1")
      },
      reconcileInvoice: async () => [pending("q-1")],
      cancelInvoice: async () => ({ provider: "qpay" as const, merchantAccountID: "test", externalInvoiceID: "q-1" }),
    }
    await expect(runPaymentSandboxSmoke(input({ confirmation: undefined, provider: "qpay", qpay }))).rejects.toThrow(
      "зөвшөөрнө үү",
    )
    await expect(runPaymentSandboxSmoke(input({ environment: "production", provider: "qpay", qpay }))).rejects.toThrow(
      "Production",
    )
    expect(calls).toBe(0)
  })

  test("redacts configured secrets from operator errors", () => {
    expect(redactSecrets("QPay failed: client-secret and bonum-secret", ["client-secret", "bonum-secret"])).toBe(
      "QPay failed: [НУУЦ] and [НУУЦ]",
    )
  })

  test("QPay reconciles pending and always cancels the sandbox invoice", async () => {
    const calls: string[] = []
    const qpay = {
      createInvoice: async () => {
        calls.push("create")
        return checkout("qpay", "q-1")
      },
      reconcileInvoice: async () => {
        calls.push("reconcile")
        return [pending("q-1")]
      },
      cancelInvoice: async () => {
        calls.push("cancel")
        return { provider: "qpay" as const, merchantAccountID: "test", externalInvoiceID: "q-1" }
      },
    }
    await expect(runPaymentSandboxSmoke(input({ provider: "qpay", qpay }))).resolves.toMatchObject({
      qpay: { cancelled: true },
    })
    expect(calls).toEqual(["create", "reconcile", "cancel"])
  })

  test("QPay cancellation still runs when reconciliation fails", async () => {
    const calls: string[] = []
    const qpay = {
      createInvoice: async () => checkout("qpay", "q-1"),
      reconcileInvoice: async () => {
        calls.push("reconcile")
        throw new Error("sandbox failure")
      },
      cancelInvoice: async () => {
        calls.push("cancel")
        return { provider: "qpay" as const, merchantAccountID: "test", externalInvoiceID: "q-1" }
      },
    }
    await expect(runPaymentSandboxSmoke(input({ provider: "qpay", qpay }))).rejects.toThrow("sandbox failure")
    expect(calls).toEqual(["reconcile", "cancel"])
  })

  test("Bonum receives a short expiry and validates checkout", async () => {
    let expiresAt = 0
    const bonum = {
      createInvoice: async (request: { expiresAt?: number }) => {
        expiresAt = request.expiresAt ?? 0
        return checkout("bonum", "b-1")
      },
    }
    const result = await runPaymentSandboxSmoke(input({ provider: "bonum", bonum }))
    expect(expiresAt).toBe(301_000)
    expect(result.bonum).toMatchObject({
      externalInvoiceID: "b-1",
      checkoutURL: "https://ecommerce.bonum.mn/ecommerce?invoiceId=b-1",
    })
  })

  test("selects only the requested provider and rejects unsafe callback URLs", async () => {
    let qpayCalled = false
    const qpay = {
      createInvoice: async () => {
        qpayCalled = true
        return checkout("qpay", "q-1")
      },
      reconcileInvoice: async () => [pending("q-1")],
      cancelInvoice: async () => ({ provider: "qpay" as const, merchantAccountID: "test", externalInvoiceID: "q-1" }),
    }
    const bonum = { createInvoice: async () => checkout("bonum", "b-1") }
    await runPaymentSandboxSmoke(input({ provider: "bonum", qpay, bonum }))
    expect(qpayCalled).toBe(false)
    await expect(
      runPaymentSandboxSmoke(input({ provider: "bonum", callbackBaseURL: "http://pay.dev.mgpt.mn", bonum })),
    ).rejects.toThrow("HTTPS")
    await expect(
      runPaymentSandboxSmoke(input({ provider: "bonum", callbackBaseURL: "https://app.mgpt.mn", bonum })),
    ).rejects.toThrow("pay.dev")
    await expect(
      runPaymentSandboxSmoke(input({ provider: "bonum", callbackBaseURL: "not-a-url", bonum })),
    ).rejects.toThrow("хүчинтэй URL")
    await expect(
      runPaymentSandboxSmoke(
        input({ provider: "bonum", callbackBaseURL: "https://pay.dev.mgpt.mn/v1/webhooks/bonum", bonum }),
      ),
    ).rejects.toThrow("base URL")
  })
})
