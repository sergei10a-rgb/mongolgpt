import { describe, expect, test } from "bun:test"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { AdminPaymentRefundServiceError } from "../src/lib/admin-payment-refund.server"
import { refundAdminSubscriptionPayment, type AdminRefundDependencies } from "../src/lib/admin-billing"

const invoiceID = "inv_01ARZ3NDEKTSV4RRFFQ69G5FAV"
const requestKey = "11111111-1111-4111-8111-111111111111"
const reason = "Хэрэглэгчийн баталгаажсан хүсэлтээр төлбөрийг бүтнээр буцааж байна"
const confirmation = "refund" as const

const owner: PlatformAdminContext = {
  id: "adm_owner",
  email: "owner@mgpt.mn",
  subject: "access-owner",
  role: "owner",
  permissions: ["billing.read", "payments.refund"],
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

function dependencies(overrides: Partial<AdminRefundDependencies> = {}) {
  const calls: string[] = []
  const auditAdminIDs: (string | undefined)[] = []
  const dependencySet: AdminRefundDependencies = {
    writeAudit: async (audit) => {
      calls.push(`audit:${audit.action}`)
      auditAdminIDs.push(audit.adminID)
    },
    refundPayment: async () => {
      calls.push("refund")
      return { invoiceID, provider: "qpay", status: "refunded" }
    },
    ...overrides,
  }
  return { auditAdminIDs, calls, dependencySet }
}

describe("platform admin payment refund", () => {
  test("denies missing permission, audits the denial, and never calls the payment service", async () => {
    const { auditAdminIDs, calls, dependencySet } = dependencies()

    const result = await refundAdminSubscriptionPayment(readonlyAdmin, request(), input(), dependencySet)

    expect(result.ok).toBe(false)
    expect(calls).toEqual(["audit:payments.refund"])
    expect(auditAdminIDs).toEqual([readonlyAdmin.id])
  })

  test("does not move money when the requested audit fails", async () => {
    const { calls, dependencySet } = dependencies({
      writeAudit: async (audit) => {
        calls.push(`audit:${audit.action}`)
        if (audit.action === "payments.refund.requested") throw new Error("audit unavailable")
      },
    })

    const result = await refundAdminSubscriptionPayment(owner, request(), input(), dependencySet)

    expect(result.ok).toBe(false)
    expect(calls).toEqual(["audit:payments.refund.requested"])
  })

  test("orders requested audit, provider refund, and success audit", async () => {
    const { auditAdminIDs, calls, dependencySet } = dependencies()

    const result = await refundAdminSubscriptionPayment(owner, request(), input(), dependencySet)

    expect(result.ok).toBe(true)
    expect(calls).toEqual(["audit:payments.refund.requested", "refund", "audit:payments.refund"])
    expect(auditAdminIDs).toEqual([owner.id, owner.id])
  })

  test("attempts failure audit and returns false when the provider rejects the refund", async () => {
    const { calls, dependencySet } = dependencies({
      refundPayment: async () => {
        calls.push("refund")
        throw new AdminPaymentRefundServiceError(422, "QPay буцаалтын хүсэлтийг зөвшөөрсөнгүй", "provider_422")
      },
    })

    const result = await refundAdminSubscriptionPayment(owner, request(), input(), dependencySet)

    expect(result.ok).toBe(false)
    expect(calls).toEqual(["audit:payments.refund.requested", "refund", "audit:payments.refund"])
  })
})
