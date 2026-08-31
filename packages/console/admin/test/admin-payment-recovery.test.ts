import { describe, expect, test } from "bun:test"
import { hasPlatformAdminPermission, PlatformAdminPermissions } from "../../core/src/platform-admin"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { retryAdminPaymentRecovery, type AdminPaymentRecoveryDependencies } from "../src/lib/admin-payment-recovery"

function context(role: PlatformAdminContext["role"]): PlatformAdminContext {
  return {
    id: "adm_01K3ABCDEFGHJKMNPQRSTVWXYZ",
    email: `${role}@mgpt.mn`,
    subject: `subject-${role}`,
    role,
    permissions: PlatformAdminPermissions.filter((permission) => hasPlatformAdminPermission(role, permission)),
    requestID: "request-1",
    bootstrapped: false,
  }
}

function request() {
  return new Request("https://admin.dev.mgpt.mn/billing/recovery", {
    method: "POST",
    headers: {
      origin: "https://admin.dev.mgpt.mn",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
  })
}

function crossOriginRequest() {
  return new Request("https://admin.dev.mgpt.mn/billing/recovery", {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
  })
}

const validInput = {
  recoveryID: "prc_01JV5T0G9H5Q3N7S2R8M4K6WXA",
  requestKey: "33333333-3333-4333-8333-333333333333",
  reason: "Хуваарьт ажлаар аюулгүй давтан оролдож, гар шалгалтаас буцаан оруулж байна.",
  confirmation: "retry",
} as const

function dependencies(overrides: Partial<AdminPaymentRecoveryDependencies> = {}) {
  const audits: unknown[] = []
  const dependencySet: AdminPaymentRecoveryDependencies = {
    transaction: async (callback) => callback({} as never),
    writeAdminAudit: async (audit) => {
      audits.push(audit)
    },
    writeAdminAuditWithDb: async (_db, audit) => {
      audits.push(audit)
    },
    retryPaymentRecoveryWithDb: async () => ({
      id: "prc_01JV5T0G9H5Q3N7S2R8M4K6WXA",
      status: "pending" as const,
      attempts: 0,
      previousStatus: "manual_review",
      previousAttempts: 6,
      previousLastErrorCode: "payment_apply_failed",
      timeNextAttempt: new Date("2026-08-31T00:00:00.000Z"),
    }),
    ...overrides,
  }
  return { audits, dependencySet }
}

describe("admin payment recovery retry", () => {
  test("denies admins without payments.recover and audits the refusal", async () => {
    const { audits, dependencySet } = dependencies()
    const result = await retryAdminPaymentRecovery(context("finance"), request(), validInput, dependencySet)

    expect(result).toEqual({
      ok: false,
      message: "Энэ үйлдлийг хийх админы эрх хүрэлцэхгүй байна.",
    })
    expect(audits).toEqual([
      expect.objectContaining({
        action: "payment_recovery.retry",
        outcome: "denied",
        targetID: "prc_01JV5T0G9H5Q3N7S2R8M4K6WXA",
      }),
    ])
  })

  test("writes an atomic success audit after re-queueing a valid recovery record", async () => {
    const { audits, dependencySet } = dependencies()
    const result = await retryAdminPaymentRecovery(context("administrator"), request(), validInput, dependencySet)

    expect(result.ok).toBe(true)
    expect(audits).toEqual([
      expect.objectContaining({
        action: "payment_recovery.retry",
        outcome: "success",
        targetID: "prc_01JV5T0G9H5Q3N7S2R8M4K6WXA",
        metadata: expect.objectContaining({
          before_status: "manual_review",
          after_status: "pending",
          previous_attempts: 6,
          previous_last_error_code: "payment_apply_failed",
        }),
      }),
    ])
  })

  test("rejects cross-origin requests before calling the recovery primitive", async () => {
    let called = false
    const { audits, dependencySet } = dependencies({
      retryPaymentRecoveryWithDb: async () => {
        called = true
        throw new Error("must not run")
      },
    })

    const result = await retryAdminPaymentRecovery(
      context("administrator"),
      crossOriginRequest(),
      validInput,
      dependencySet,
    )

    expect(result.ok).toBe(false)
    expect(called).toBe(false)
    expect(audits).toEqual([
      expect.objectContaining({
        action: "payment_recovery.retry",
        outcome: "denied",
        metadata: { reason: "request_origin" },
      }),
    ])
  })

  test("does not report success when the atomic success audit fails", async () => {
    const { audits, dependencySet } = dependencies({
      writeAdminAuditWithDb: async () => {
        throw new Error("audit unavailable")
      },
    })

    const result = await retryAdminPaymentRecovery(context("administrator"), request(), validInput, dependencySet)

    expect(result).toEqual({
      ok: false,
      message: "Сэргээх бүртгэлд давтан оролдох үед дотоод алдаа гарлаа.",
    })
    expect(audits).toEqual([
      expect.objectContaining({
        action: "payment_recovery.retry",
        outcome: "failure",
        metadata: { reason: "internal_error" },
      }),
    ])
  })
})
