import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { AdminPlanMutationInput, type AdminPlansDependencies, mutateAdminPlans } from "../src/lib/admin-plans"
import { requirePlatformAdminPermission } from "../src/lib/admin-auth"
import { Database } from "bun:sqlite"
import { createSqliteDatabase, sqliteBatch } from "../../core/test/fixtures/sqlite-batch"

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

async function fixture() {
  const sqlite = new Database(":memory:")
  const directory = resolve(import.meta.dir, "../../core/migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  for (const path of paths.sort()) sqlite.exec(await Bun.file(path).text())
  sqlite
    .query("insert into platform_admin(id,email,access_subject,role,status) values (?,?,?,'owner','active')")
    .run(context.id, context.email, context.subject)
  const db = createSqliteDatabase(sqlite)
  const dependencies: AdminPlansDependencies = {
    bootstrap: () => ({
      ...limits,
      lite: legacyLite,
      free: { ...limits.free, checkHeaders: { "x-proxy": "private-test" } },
    }),
    batch: sqliteBatch(async (callback) => {
      sqlite.exec("BEGIN")
      try {
        const result = await callback(db)
        sqlite.exec("COMMIT")
        return result
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    }),
  }
  return { sqlite, dependencies }
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

  test("persists the version, activation and audit atomically without proxy secrets", async () => {
    const { sqlite, dependencies } = await fixture()
    try {
      const result = await mutateAdminPlans(context, request(), updateRequest(), dependencies)
      expect(result).toMatchObject({ ok: true, revision: 1 })
      const version = sqlite
        .query<{ id: string; limits: string }, []>("select id, limits from plan_config_version")
        .get()!
      expect(JSON.parse(version.limits)).toEqual({ ...limits, lite: legacyLite })
      expect(version.limits).not.toContain("private-test")
      expect(sqlite.query("select active_version_id,revision from plan_config_active").get()).toEqual({
        active_version_id: version.id,
        revision: 1,
      })
      expect(sqlite.query("select action,outcome,target_id from admin_audit_log").get()).toEqual({
        action: "plans.update",
        outcome: "success",
        target_id: version.id,
      })
    } finally {
      sqlite.close()
    }
  })

  test("rollback creates and activates a new immutable version", async () => {
    const { sqlite, dependencies } = await fixture()
    try {
      const first = await mutateAdminPlans(context, request(), updateRequest(), dependencies)
      if (!first.ok) throw new Error(first.message)
      const before = sqlite.query("select * from plan_config_version").all()
      const result = await mutateAdminPlans(
        context,
        request(),
        {
          operation: "rollback",
          sourceVersionID: first.versionID,
          confirmation: "БУЦААХ",
          expectedRevision: "1",
          expectedActiveStateRevision: "1",
          note: "Өмнөх тогтвортой хувилбар руу буцаалаа.",
        },
        dependencies,
      )
      expect(result).toMatchObject({ ok: true, revision: 2 })
      expect(sqlite.query("select * from plan_config_version where revision=1").all()).toEqual(before)
      expect(sqlite.query("select source_version_id from plan_config_version where revision=2").get()).toEqual({
        source_version_id: first.versionID,
      })
      expect(sqlite.query("select action,outcome from admin_audit_log order by id desc limit 1").get()).toEqual({
        action: "plans.rollback",
        outcome: "success",
      })
    } finally {
      sqlite.close()
    }
  })

  test("audit failure rolls back the version and activation and records a failure", async () => {
    const { sqlite, dependencies } = await fixture()
    try {
      sqlite.exec(
        "create trigger reject_audit before insert on admin_audit_log when NEW.outcome='success' begin select raise(abort,'synthetic audit failure'); end",
      )
      const result = await mutateAdminPlans(context, request(), updateRequest(), dependencies)
      expect(result).toMatchObject({ ok: false })
      expect(result.message).not.toContain("Өөрчлөлт хийгдээгүй")
      expect(sqlite.query("select * from plan_config_version").all()).toEqual([])
      expect(sqlite.query("select * from plan_config_active").all()).toEqual([])
      expect(sqlite.query("select outcome from admin_audit_log").get()).toEqual({ outcome: "failure" })
    } finally {
      sqlite.close()
    }
  })

  test("does not call plan primitives when origin, permission, or input validation is denied", async () => {
    const { sqlite, dependencies } = await fixture()
    try {
      await mutateAdminPlans(context, request({ origin: "https://attacker.example" }), updateRequest(), dependencies)
      await mutateAdminPlans({ ...context, permissions: [] }, request(), updateRequest(), dependencies)
      await mutateAdminPlans(context, request(), { operation: "update" }, dependencies)
      expect(sqlite.query("select * from plan_config_version").all()).toEqual([])
      expect(sqlite.query("select outcome from admin_audit_log").all()).toEqual([
        { outcome: "denied" },
        { outcome: "denied" },
        { outcome: "denied" },
      ])
    } finally {
      sqlite.close()
    }
  })

  test("keeps mutation ordering, bounded history, and secret-free contracts", async () => {
    const plans = await source("src/lib/admin-plans.ts")
    const route = await source("src/routes/plans/index.tsx")
    const header = await source("src/component/admin-header.tsx")
    const infraConsole = await source("../../../infra/console.ts")
    const infraAdmin = await source("../../../infra/admin-standalone.ts")

    expect(plans).toContain('requirePlatformAdminPermission(context, "plans.manage")')
    expect(plans).toContain("requireSameOriginAdminMutation(request)")
    expect(plans).not.toContain("Database.transaction")
    expect(plans).toContain("dependencies.batch ?? Database.batch")
    expect(plans).toContain("paymentBatchGuard")
    expect(plans).toContain("PlatformAdminTable.access_subject")
    expect(plans).toContain("adminAuditQuery(db")
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
