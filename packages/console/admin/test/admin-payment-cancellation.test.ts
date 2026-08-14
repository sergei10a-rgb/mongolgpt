import { describe, expect, test } from "bun:test"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { AdminPaymentCancellationServiceError } from "../src/lib/admin-payment-cancellation.server"
import { cancelAdminSubscriptionCheckout, type AdminCancellationDependencies } from "../src/lib/admin-billing"

const invoiceID = "inv_01ARZ3NDEKTSV4RRFFQ69G5FAV"
const requestKey = "11111111-1111-4111-8111-111111111111"
const reason = "Төлбөрийн нэхэмжлэл давхар үүссэн тул админ цуцалж байна"
const confirmation = "cancel" as const

const owner: PlatformAdminContext = {
  id: "adm_owner",
  email: "owner@mgpt.mn",
  subject: "access-owner",
  role: "owner",
  permissions: ["billing.read", "payments.cancel"],
  requestID: "req_owner",
  bootstrapped: false,
}

const readonlyAdmin: PlatformAdminContext = {
  ...owner,
  id: "adm_readonly",
  email: "readonly@mgpt.mn",
  role: "administrator",
  permissions: ["billing.read"],
}

function request() {
  return new Request("https://admin.dev.mgpt.mn/_server", {
    method: "POST",
    headers: {
      Origin: "https://admin.dev.mgpt.mn",
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "same-origin",
    },
  })
}

function input() {
  return { invoiceID, requestKey, reason, confirmation }
}

function dependencies(overrides: Partial<AdminCancellationDependencies> = {}) {
  const calls: string[] = []
  const auditAdminIDs: (string | undefined)[] = []
  const dependencySet: AdminCancellationDependencies = {
    writeAudit: async (audit) => {
      calls.push(`audit:${audit.action}`)
      auditAdminIDs.push(audit.adminID)
    },
    cancelCheckout: async () => {
      calls.push("cancel")
      return { invoiceID, provider: "qpay", status: "cancelled" }
    },
    ...overrides,
  }
  return { auditAdminIDs, calls, dependencySet }
}

describe("platform admin payment cancellation", () => {
  test("denies missing permission, audits the denial, and never calls the provider", async () => {
    const { auditAdminIDs, calls, dependencySet } = dependencies()

    const result = await cancelAdminSubscriptionCheckout(readonlyAdmin, request(), input(), dependencySet)

    expect(result.ok).toBe(false)
    expect(calls).toEqual(["audit:payments.cancel"])
    expect(auditAdminIDs).toEqual([readonlyAdmin.id])
  })

  test("fails closed when the denied audit cannot be written", async () => {
    const { calls, dependencySet } = dependencies({
      writeAudit: async () => {
        calls.push("audit-failed")
        throw new Error("audit unavailable")
      },
    })

    const result = await cancelAdminSubscriptionCheckout(readonlyAdmin, request(), input(), dependencySet)

    expect(result.ok).toBe(false)
    expect(result.message).toContain("аудит")
    expect(calls).toEqual(["audit-failed"])
  })

  test("does not call the provider when the requested audit fails", async () => {
    const { calls, dependencySet } = dependencies({
      writeAudit: async (audit) => {
        calls.push(`audit:${audit.action}`)
        if (audit.action === "payments.cancel.requested") throw new Error("audit unavailable")
      },
    })

    const result = await cancelAdminSubscriptionCheckout(owner, request(), input(), dependencySet)

    expect(result.ok).toBe(false)
    expect(calls).toEqual(["audit:payments.cancel.requested"])
  })

  test("orders requested audit, provider cancellation, and success audit", async () => {
    const { auditAdminIDs, calls, dependencySet } = dependencies()

    const result = await cancelAdminSubscriptionCheckout(owner, request(), input(), dependencySet)

    expect(result.ok).toBe(true)
    expect(calls).toEqual(["audit:payments.cancel.requested", "cancel", "audit:payments.cancel"])
    expect(auditAdminIDs).toEqual([owner.id, owner.id])
  })

  test("attempts failure audit and returns false when the provider fails", async () => {
    const { calls, dependencySet } = dependencies({
      cancelCheckout: async () => {
        calls.push("cancel")
        throw new AdminPaymentCancellationServiceError(502, "Төлбөрийн үйлчилгээний алдаа", "provider_error")
      },
    })

    const result = await cancelAdminSubscriptionCheckout(owner, request(), input(), dependencySet)

    expect(result.ok).toBe(false)
    expect(calls).toEqual(["audit:payments.cancel.requested", "cancel", "audit:payments.cancel"])
  })
})
