import { z } from "zod"
import { Database, desc } from "@mongolgpt/console-core/drizzle/index.js"
import {
  PlanConfig,
  PlanConfigConflictError,
  PlanConfigInvalidActiveError,
} from "@mongolgpt/console-core/plan-config.js"
import { PlanConfigVersionTable } from "@mongolgpt/console-core/schema/plan-config.sql.js"
import { Subscription } from "@mongolgpt/console-core/subscription.js"
import type { PlatformAdminContext } from "./admin-context"
import {
  AdminAuthorizationError,
  requirePlatformAdminPermission,
  writeAdminAudit,
  writeAdminAuditWithDb,
} from "./admin-auth"
import { AdminMutationRequestError, requireSameOriginAdminMutation } from "./admin-mutation"

const safeInteger = (maximum: number) => z.coerce.number().finite().int().safe().nonnegative().max(maximum)
const positiveInteger = (maximum: number) => safeInteger(maximum).positive()
const cyrillicNote = z
  .string()
  .trim()
  .min(5)
  .max(500)
  .regex(/[\u0400-\u04ff]/, "Тайлбар нь дор хаяж нэг кирилл тэмдэгттэй байна.")
const versionID = z.string().trim().min(1).max(30)
const revision = safeInteger(2_147_483_647)
const activeRevision = z.preprocess(
  (value) => (value === "" || value === "none" || value === null ? null : value),
  revision.nullable(),
)

const freeSchema = z
  .object({
    promoTokens: safeInteger(1_000_000_000),
    dailyRequests: positiveInteger(10_000_000),
    dailyRequestsFallback: positiveInteger(10_000_000),
  })
  .strict()

const paidSchema = z
  .object({
    weeklyCostLimit: positiveInteger(100_000_000),
    weeklyTokenLimit: positiveInteger(1_000_000_000),
    weeklyRequestLimit: positiveInteger(10_000_000),
    monthlyCostLimit: positiveInteger(400_000_000),
    monthlyTokenLimit: positiveInteger(4_000_000_000),
    monthlyRequestLimit: positiveInteger(40_000_000),
    rollingCostLimit: positiveInteger(100_000_000),
    rollingWindow: positiveInteger(168),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.monthlyCostLimit < value.weeklyCostLimit)
      ctx.addIssue({
        code: "custom",
        path: ["monthlyCostLimit"],
        message: "Сарын зардал долоо хоногийнхоос бага байж болохгүй.",
      })
    if (value.monthlyTokenLimit < value.weeklyTokenLimit)
      ctx.addIssue({
        code: "custom",
        path: ["monthlyTokenLimit"],
        message: "Сарын token долоо хоногийнхоос бага байж болохгүй.",
      })
    if (value.monthlyRequestLimit < value.weeklyRequestLimit)
      ctx.addIssue({
        code: "custom",
        path: ["monthlyRequestLimit"],
        message: "Сарын хүсэлт долоо хоногийнхоос бага байж болохгүй.",
      })
    if (value.rollingCostLimit > value.weeklyCostLimit)
      ctx.addIssue({
        code: "custom",
        path: ["rollingCostLimit"],
        message: "Rolling зардал долоо хоногийн зардлаас их байж болохгүй.",
      })
  })

const updateInput = z
  .object({
    operation: z.literal("update"),
    expectedRevision: revision,
    expectedActiveStateRevision: activeRevision,
    note: cyrillicNote,
    free: freeSchema,
    plans: z.object({ basic: paidSchema, pro: paidSchema, max: paidSchema }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of [
      "weeklyCostLimit",
      "weeklyTokenLimit",
      "weeklyRequestLimit",
      "monthlyCostLimit",
      "monthlyTokenLimit",
      "monthlyRequestLimit",
      "rollingCostLimit",
    ] as const) {
      if (value.plans.basic[key] > value.plans.pro[key] || value.plans.pro[key] > value.plans.max[key]) {
        ctx.addIssue({
          code: "custom",
          path: ["plans", "basic", key],
          message: "Basic, Pro, Max шатлал өсөх дарааллаар байна.",
        })
        break
      }
    }
    if (
      value.plans.basic.rollingWindow > value.plans.pro.rollingWindow ||
      value.plans.pro.rollingWindow > value.plans.max.rollingWindow
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["plans", "basic", "rollingWindow"],
        message: "Basic, Pro, Max rolling хугацаа өсөх дарааллаар байна.",
      })
    }
  })

const rollbackInput = z
  .object({
    operation: z.literal("rollback"),
    sourceVersionID: versionID,
    confirmation: z.literal("БУЦААХ"),
    expectedRevision: revision,
    expectedActiveStateRevision: activeRevision,
    note: cyrillicNote,
  })
  .strict()

export const AdminPlanMutationInput = z.discriminatedUnion("operation", [updateInput, rollbackInput])

export interface AdminPlansDependencies {
  transaction: typeof Database.transaction
  getRuntimeLimitsWithDb: typeof PlanConfig.getRuntimeLimitsWithDb
  createVersionWithDb: typeof PlanConfig.createVersionWithDb
  cloneVersionForRollbackWithDb: typeof PlanConfig.cloneVersionForRollbackWithDb
  activateVersionWithDb: typeof PlanConfig.activateVersionWithDb
  writeAdminAuditWithDb: typeof writeAdminAuditWithDb
  writeAdminAudit: typeof writeAdminAudit
}

const productionDependencies: AdminPlansDependencies = {
  transaction: Database.transaction,
  getRuntimeLimitsWithDb: PlanConfig.getRuntimeLimitsWithDb,
  createVersionWithDb: PlanConfig.createVersionWithDb,
  cloneVersionForRollbackWithDb: PlanConfig.cloneVersionForRollbackWithDb,
  activateVersionWithDb: PlanConfig.activateVersionWithDb,
  writeAdminAuditWithDb,
  writeAdminAudit,
}

export async function listAdminPlans(context: PlatformAdminContext) {
  const admin = requirePlatformAdminPermission(context, "plans.manage")
  return Database.use(async (db) => {
    const [active, latest, versions] = await Promise.all([
      PlanConfig.getActiveWithDb(db),
      db
        .select({ revision: PlanConfigVersionTable.revision })
        .from(PlanConfigVersionTable)
        .orderBy(desc(PlanConfigVersionTable.revision))
        .limit(1)
        .then((rows) => rows[0]),
      db.select().from(PlanConfigVersionTable).orderBy(desc(PlanConfigVersionTable.revision)).limit(20),
    ])
    const bootstrap = PlanConfig.StoredLimitsSchema.parse(stripCheckHeaders(Subscription.getBootstrapLimits()))
    return {
      admin,
      latestRevision: latest?.revision ?? 0,
      active: active
        ? {
            source: "d1" as const,
            versionID: active.version.id,
            revision: active.version.revision,
            stateRevision: active.state.revision,
            note: active.version.note,
            timeCreated: iso(active.version.time_created),
            limits: active.limits,
          }
        : {
            source: "bootstrap" as const,
            versionID: null,
            revision: 0,
            stateRevision: null,
            note: null,
            timeCreated: null,
            limits: bootstrap,
          },
      versions: versions.map((version) => ({
        id: version.id,
        revision: version.revision,
        sourceVersionID: version.source_version_id,
        note: version.note,
        createdBy: version.created_by,
        timeCreated: iso(version.time_created),
        active: active?.version.id === version.id,
      })),
    }
  })
}

export async function mutateAdminPlans(
  context: PlatformAdminContext,
  request: Request,
  raw: unknown,
  dependencies: AdminPlansDependencies = productionDependencies,
) {
  const operation = rawOperation(raw)
  try {
    requireSameOriginAdminMutation(request)
    const admin = requirePlatformAdminPermission(context, "plans.manage")
    const input = AdminPlanMutationInput.parse(nestPlanInput(raw))
    const result = await dependencies.transaction(async (tx) => {
      const version = await (async () => {
        if (input.operation === "update") {
          const currentLimits = await dependencies.getRuntimeLimitsWithDb(tx)
          return dependencies.createVersionWithDb(tx, {
            limits: inputLimits(input, currentLimits.lite),
            createdBy: admin.id,
            note: input.note,
            expectedRevision: input.expectedRevision,
          })
        }
        return dependencies.cloneVersionForRollbackWithDb(tx, {
          sourceVersionID: input.sourceVersionID,
          createdBy: admin.id,
          note: input.note,
          expectedRevision: input.expectedRevision,
        })
      })()
      const activation = await dependencies.activateVersionWithDb(tx, {
        versionID: version.id,
        updatedBy: admin.id,
        expectedStateRevision: input.expectedActiveStateRevision,
      })
      try {
        await dependencies.writeAdminAuditWithDb(tx, {
          adminID: admin.id,
          actorEmail: admin.email,
          action: input.operation === "update" ? "plans.update" : "plans.rollback",
          outcome: "success",
          request,
          targetType: "plan_config",
          targetID: version.id,
          metadata: {
            operation: input.operation,
            new_version_id: version.id,
            source_version_id: input.operation === "rollback" ? input.sourceVersionID : null,
            revision: version.revision,
            active_state_revision: activation.revision,
          },
        })
      } catch (error) {
        throw new AdminPlanAuditWriteError(error instanceof Error ? { cause: error } : undefined)
      }
      return { versionID: version.id, revision: version.revision }
    })
    return {
      ok: true as const,
      message:
        input.operation === "update"
          ? "Төлөвлөгөөний шинэ хувилбар идэвхжлээ."
          : "Сонгосон хувилбараас шинэ буцаалтын хувилбар үүсгэж идэвхжүүллээ.",
      ...result,
    }
  } catch (error) {
    const failure = mutationFailure(error)
    try {
      await dependencies.writeAdminAudit({
        adminID: context.id,
        actorEmail: context.email,
        action: operation === "rollback" ? "plans.rollback" : "plans.update",
        outcome: failure.outcome,
        request,
        targetType: "plan_config",
        metadata: { operation, reason: failure.code },
      })
    } catch {
      return {
        ok: false as const,
        message: "Өөрчлөлт хийгдээгүй. Аудитын бүртгэл бичигдээгүй тул үйлдлийг баталгаажуулсангүй.",
      }
    }
    return { ok: false as const, message: failure.message }
  }
}

function inputLimits(
  input: z.output<typeof updateInput>,
  legacyLite: z.output<typeof Subscription.LimitsSchema>["lite"],
) {
  return PlanConfig.StoredLimitsSchema.parse({ free: input.free, lite: legacyLite, plans: input.plans })
}

function stripCheckHeaders(limits: z.output<typeof Subscription.LimitsSchema>) {
  const { checkHeaders: _checkHeaders, ...free } = limits.free
  return { ...limits, free }
}

function rawOperation(raw: unknown) {
  return typeof raw === "object" && raw !== null && "operation" in raw && raw.operation === "rollback"
    ? "rollback"
    : "update"
}

function nestPlanInput(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
  const flat = raw as Record<string, unknown>
  if (flat.free || flat.plans) return raw
  const get = (key: string) => flat[key]
  if (get("operation") === "rollback") {
    return {
      operation: get("operation"),
      sourceVersionID: get("sourceVersionID"),
      confirmation: get("confirmation"),
      expectedRevision: get("expectedRevision"),
      expectedActiveStateRevision: get("expectedActiveStateRevision"),
      note: get("note"),
    }
  }
  const paid = (tier: "basic" | "pro" | "max") => ({
    weeklyCostLimit: get(`${tier}.weeklyCostLimit`),
    weeklyTokenLimit: get(`${tier}.weeklyTokenLimit`),
    weeklyRequestLimit: get(`${tier}.weeklyRequestLimit`),
    monthlyCostLimit: get(`${tier}.monthlyCostLimit`),
    monthlyTokenLimit: get(`${tier}.monthlyTokenLimit`),
    monthlyRequestLimit: get(`${tier}.monthlyRequestLimit`),
    rollingCostLimit: get(`${tier}.rollingCostLimit`),
    rollingWindow: get(`${tier}.rollingWindow`),
  })
  return {
    operation: get("operation"),
    expectedRevision: get("expectedRevision"),
    expectedActiveStateRevision: get("expectedActiveStateRevision"),
    note: get("note"),
    sourceVersionID: get("sourceVersionID"),
    confirmation: get("confirmation"),
    free: {
      promoTokens: get("free.promoTokens"),
      dailyRequests: get("free.dailyRequests"),
      dailyRequestsFallback: get("free.dailyRequestsFallback"),
    },
    plans: { basic: paid("basic"), pro: paid("pro"), max: paid("max") },
  }
}

function mutationFailure(error: unknown) {
  if (error instanceof AdminMutationRequestError)
    return {
      outcome: "denied" as const,
      code: `request_${error.code}`,
      message: "Аюулгүй байдлын хүсэлтийн шалгалт амжилтгүй боллоо.",
    }
  if (error instanceof AdminAuthorizationError)
    return { outcome: "denied" as const, code: error.code, message: error.message }
  if (error instanceof z.ZodError)
    return {
      outcome: "denied" as const,
      code: "invalid_input",
      message: "Төлөвлөгөөний утга, шатлал, тайлбар эсвэл баталгаажуулалт буруу байна.",
    }
  if (error instanceof PlanConfigConflictError)
    return {
      outcome: "failure" as const,
      code: "conflict",
      message: "Төлөвлөгөө зэрэг өөрчлөгдсөн байна. Хуудсыг шинэчлээд дахин оролдоно уу.",
    }
  if (error instanceof PlanConfigInvalidActiveError)
    return {
      outcome: "failure" as const,
      code: "invalid_plan_config",
      message: "Төлөвлөгөөний хувилбар хүчинтэй биш байна.",
    }
  if (error instanceof AdminPlanAuditWriteError)
    return {
      outcome: "failure" as const,
      code: "audit_write_failed",
      message: "Өөрчлөлт хийгдээгүй. Аудитын бүртгэл баталгаажаагүй тул үйлдлийг цуцаллаа.",
    }
  return { outcome: "failure" as const, code: "internal_error", message: "Төлөвлөгөөг өөрчлөх үед алдаа гарлаа." }
}

function iso(value: Date | string | number) {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

class AdminPlanAuditWriteError extends Error {
  constructor(options?: ErrorOptions) {
    super("audit_write_failed", options)
    this.name = "AdminPlanAuditWriteError"
  }
}
