import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { AdminPlanMutationInput, type AdminPlansDependencies, mutateAdminPlans } from "../src/lib/admin-plans"
import { requirePlatformAdminPermission } from "../src/lib/admin-auth"

const limits = {
  free: { promoTokens: 0, dailyRequests: 20, dailyRequestsFallback: 5 },
  plans: {
    basic: {
      weeklyCostLimit: 1,
      weeklyTokenLimit: 100,
      weeklyRequestLimit: 10,
      monthlyCostLimit: 4,
      monthlyTokenLimit: 400,
      monthlyRequestLimit: 40,
      rollingCostLimit: 1,
      rollingWindow: 5,
    },
    pro: {
      weeklyCostLimit: 2,
      weeklyTokenLimit: 200,
      weeklyRequestLimit: 20,
      monthlyCostLimit: 8,
      monthlyTokenLimit: 800,
      monthlyRequestLimit: 80,
      rollingCostLimit: 2,
      rollingWindow: 8,
    },
    max: {
      weeklyCostLimit: 3,
      weeklyTokenLimit: 300,
      weeklyRequestLimit: 30,
      monthlyCostLimit: 12,
      monthlyTokenLimit: 1200,
      monthlyRequestLimit: 120,
      rollingCostLimit: 3,
      rollingWindow: 12,
    },
  },
}
const legacyLite = { rollingLimit: 1, rollingWindow: 5, weeklyLimit: 5, monthlyLimit: 10 }

const context: PlatformAdminContext = {
  id: "adm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  email: "owner@mgpt.mn",
  subject: "access-owner",
  role: "owner",
  permissions: ["plans.manage"],
  requestID: "req_owner",
  bootstrapped: false,
}

async function source(path: string) {
  return Bun.file(resolve(import.meta.dir, "..", path)).text()
}

function request(headers: HeadersInit = {}) {
  return new Request("https://admin.mgpt.mn/plans", {
    method: "POST",
    headers: { origin: "https://admin.mgpt.mn", "content-type": "application/x-www-form-urlencoded", ...headers },
  })
}

function updateRequest() {
  return {
    operation: "update",
    expectedRevision: "0",
    expectedActiveStateRevision: "none",
    note: "Үнийн багцын хязгаарыг шинэчиллээ.",
    ...limits,
  }
}

function dependencies(events: string[], overrides: Partial<AdminPlansDependencies> = {}): AdminPlansDependencies {
  const tx = {} as never
  return {
    transaction: (async (callback) => callback(tx)) as AdminPlansDependencies["transaction"],
    getRuntimeLimitsWithDb: (async () => ({
      ...limits,
      free: { ...limits.free, checkHeaders: { "x-mongolgpt-proxy": "test" } },
      lite: legacyLite,
    })) as AdminPlansDependencies["getRuntimeLimitsWithDb"],
    createVersionWithDb: (async () => {
      events.push("create")
      return { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", revision: 1 }
    }) as unknown as AdminPlansDependencies["createVersionWithDb"],
    cloneVersionForRollbackWithDb: (async () => {
      events.push("clone")
      return { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", revision: 1 }
    }) as unknown as AdminPlansDependencies["cloneVersionForRollbackWithDb"],
    activateVersionWithDb: (async () => {
      events.push("activate")
      return { activeVersionID: "01ARZ3NDEKTSV4RRFFQ69G5FAV", revision: 1 }
    }) as AdminPlansDependencies["activateVersionWithDb"],
    writeAdminAuditWithDb: (async () => {
      events.push("success-audit")
    }) as AdminPlansDependencies["writeAdminAuditWithDb"],
    writeAdminAudit: (async () => {
      events.push("failure-audit")
    }) as AdminPlansDependencies["writeAdminAudit"],
    ...overrides,
  }
}

describe("admin plan management", () => {
  test("accepts a complete bounded Mongolian update and rejects invalid numeric invariants", () => {
    const valid = updateRequest()
    expect(AdminPlanMutationInput.parse(valid)).toMatchObject({
      operation: "update",
      expectedRevision: 0,
      expectedActiveStateRevision: null,
    })
    expect(AdminPlanMutationInput.safeParse({ ...valid, note: "english only" }).success).toBe(false)
    expect(AdminPlanMutationInput.safeParse({ ...valid, lite: legacyLite }).success).toBe(false)
    expect(
      AdminPlanMutationInput.safeParse({
        ...valid,
        plans: { ...limits.plans, basic: { ...limits.plans.basic, monthlyCostLimit: 0 } },
      }).success,
    ).toBe(false)
    expect(
      AdminPlanMutationInput.safeParse({
        ...valid,
        plans: { ...limits.plans, pro: { ...limits.plans.pro, weeklyCostLimit: 0 } },
      }).success,
    ).toBe(false)
    expect(
      AdminPlanMutationInput.safeParse({
        ...valid,
        plans: { ...limits.plans, basic: { ...limits.plans.basic, rollingCostLimit: 2 } },
      }).success,
    ).toBe(false)
    expect(
      AdminPlanMutationInput.safeParse({
        ...valid,
        plans: { ...limits.plans, max: { ...limits.plans.max, rollingWindow: 169 } },
      }).success,
    ).toBe(false)
    expect(
      AdminPlanMutationInput.safeParse({
        ...valid,
        plans: { ...limits.plans, pro: { ...limits.plans.pro, weeklyTokenLimit: 50 } },
      }).success,
    ).toBe(false)
  })

  test("requires a matching confirmation and Mongolian note for immutable rollback", () => {
    const valid = {
      operation: "rollback",
      sourceVersionID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      confirmation: "БУЦААХ",
      expectedRevision: "4",
      expectedActiveStateRevision: "2",
      note: "Өмнөх тогтвортой хувилбар руу буцаалаа.",
    }
    expect(AdminPlanMutationInput.parse(valid)).toMatchObject({ expectedRevision: 4, expectedActiveStateRevision: 2 })
    expect(AdminPlanMutationInput.safeParse({ ...valid, confirmation: "тийм" }).success).toBe(false)
    expect(AdminPlanMutationInput.safeParse({ ...valid, note: "short" }).success).toBe(false)
  })

  test("requires plans.manage", () => {
    expect(() => requirePlatformAdminPermission(context, "plans.manage")).not.toThrow()
    expect(() => requirePlatformAdminPermission({ ...context, permissions: [] }, "plans.manage")).toThrow(
      "эрх хүрэлцэхгүй",
    )
  })

  test("runs update in create, activate, success-audit order inside one transaction", async () => {
    const events: string[] = []
    let stored: unknown
    const result = await mutateAdminPlans(
      context,
      request(),
      updateRequest(),
      dependencies(events, {
        createVersionWithDb: (async (_tx, input) => {
          stored = input.limits
          events.push("create")
          return { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", revision: 1 }
        }) as AdminPlansDependencies["createVersionWithDb"],
      }),
    )
    expect(result).toMatchObject({ ok: true, versionID: "01ARZ3NDEKTSV4RRFFQ69G5FAV", revision: 1 })
    expect(stored).toMatchObject({ lite: legacyLite })
    expect(events).toEqual(["create", "activate", "success-audit"])
  })

  test("runs rollback in clone, activate, success-audit order inside one transaction", async () => {
    const events: string[] = []
    const result = await mutateAdminPlans(
      context,
      request(),
      {
        operation: "rollback",
        sourceVersionID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        confirmation: "БУЦААХ",
        expectedRevision: "0",
        expectedActiveStateRevision: "none",
        note: "Өмнөх тогтвортой хувилбар руу буцаалаа.",
      },
      dependencies(events),
    )
    expect(result).toMatchObject({ ok: true, versionID: "01ARZ3NDEKTSV4RRFFQ69G5FAV", revision: 1 })
    expect(events).toEqual(["clone", "activate", "success-audit"])
  })

  test("does not report success when the transaction audit fails and records an external failure audit", async () => {
    const events: string[] = []
    const result = await mutateAdminPlans(
      context,
      request(),
      updateRequest(),
      dependencies(events, {
        writeAdminAuditWithDb: (async () => {
          events.push("success-audit")
          throw new Error("audit unavailable")
        }) as AdminPlansDependencies["writeAdminAuditWithDb"],
      }),
    )
    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain("Өөрчлөлт хийгдээгүй")
    expect(events).toEqual(["create", "activate", "success-audit", "failure-audit"])
  })

  test("does not call plan primitives when origin, permission, or input validation is denied", async () => {
    const originEvents: string[] = []
    await mutateAdminPlans(
      context,
      request({ origin: "https://attacker.example" }),
      updateRequest(),
      dependencies(originEvents),
    )
    expect(originEvents).toEqual(["failure-audit"])

    const permissionEvents: string[] = []
    await mutateAdminPlans({ ...context, permissions: [] }, request(), updateRequest(), dependencies(permissionEvents))
    expect(permissionEvents).toEqual(["failure-audit"])

    const inputEvents: string[] = []
    await mutateAdminPlans(context, request(), { operation: "update" }, dependencies(inputEvents))
    expect(inputEvents).toEqual(["failure-audit"])
  })

  test("keeps mutation ordering, bounded history, and secret-free contracts", async () => {
    const plans = await source("src/lib/admin-plans.ts")
    const route = await source("src/routes/plans/index.tsx")
    const header = await source("src/component/admin-header.tsx")
    const infraConsole = await source("../../../infra/console.ts")
    const infraAdmin = await source("../../../infra/admin-standalone.ts")

    expect(plans).toContain('requirePlatformAdminPermission(context, "plans.manage")')
    expect(plans).toContain("requireSameOriginAdminMutation(request)")
    expect(plans).toContain("transaction: Database.transaction")
    expect(plans).toContain("getRuntimeLimitsWithDb: PlanConfig.getRuntimeLimitsWithDb")
    expect(plans).toContain("dependencies.createVersionWithDb(tx")
    expect(plans).toContain("dependencies.cloneVersionForRollbackWithDb(tx")
    expect(plans).toContain("dependencies.activateVersionWithDb(tx")
    expect(plans).toContain("dependencies.writeAdminAuditWithDb(tx")
    expect(plans).toContain(".limit(20)")
    expect(plans).toContain("stripCheckHeaders")
    expect(plans).not.toContain("metadata: { limits")
    expect(route).toContain("Төлөвлөгөөний удирдлага")
    expect(route).toContain('aria-label="Төлөвлөгөөний хэрэглээний хязгаар шинэчлэх"')
    expect(route).not.toContain("Lite")
    expect(route).toContain("Үнэгүй")
    expect(route).toContain("Нөөц өдрийн хүсэлт")
    expect(route).toContain("Гулсах цонхны")
    expect(route).toContain("D1 өгөгдлийн сан")
    expect(route).toContain("буцааж засах боломжгүй")
    expect(route).toContain("үйлдлийн бүртгэл")
    expect(route).not.toContain(">Free<")
    expect(route).not.toContain(">Legacy Lite compatibility<")
    expect(route).not.toContain("Bootstrap эх сурвалж")
    expect(route).not.toContain("Fallback өдрийн хүсэлт")
    expect(route).not.toContain("checkHeaders")
    expect(header).toContain('permissions.includes("plans.manage")')
    expect(header).toContain('href="/plans"')
    expect(infraConsole).toContain('export const mongolGPTPlanLimits = new sst.Secret("MONGOLGPT_PLAN_LIMITS")')
    expect(infraAdmin).toContain('new sst.Secret("MONGOLGPT_PLAN_LIMITS")')
    expect(infraAdmin).toContain("mongolGPTPlanLimits,")
  })
})
