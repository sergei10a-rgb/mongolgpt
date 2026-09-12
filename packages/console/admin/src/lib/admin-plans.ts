import { z } from "zod"
import { ulid } from "ulid"
import {
  Database,
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  notExists,
  sql,
} from "@mongolgpt/console-core/drizzle/index.js"
import {
  PlanConfig,
  PlanConfigConflictError,
  PlanConfigInvalidActiveError,
} from "@mongolgpt/console-core/plan-config.js"
import { PlanConfigActiveTable, PlanConfigVersionTable } from "@mongolgpt/console-core/schema/plan-config.sql.js"
import { PlatformAdminRoles, PlatformAdminTable } from "@mongolgpt/console-core/schema/admin.sql.js"
import { hasPlatformAdminPermission } from "@mongolgpt/console-core/platform-admin.js"
import { paymentBatchGuard } from "@mongolgpt/console-core/payment-ledger.js"
import { Subscription } from "@mongolgpt/console-core/subscription.js"
import type { PlatformAdminContext } from "./admin-context"
import { AdminAuthorizationError, requirePlatformAdminPermission, adminAuditQuery } from "./admin-auth"
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
  batch?: typeof Database.batch
  bootstrap?: () => ReturnType<typeof Subscription.getBootstrapLimits>
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
  dependencies: AdminPlansDependencies = {},
) {
  const batch = dependencies.batch ?? Database.batch
  const operation = rawOperation(raw)
  try {
    requireSameOriginAdminMutation(request)
    const admin = requirePlatformAdminPermission(context, "plans.manage")
    const input = AdminPlanMutationInput.parse(nestPlanInput(raw))
    const actor = and(
      eq(PlatformAdminTable.id, admin.id),
      eq(PlatformAdminTable.email, admin.email),
      eq(PlatformAdminTable.access_subject, admin.subject),
      eq(PlatformAdminTable.status, "active"),
      isNull(PlatformAdminTable.timeDeleted),
      inArray(
        PlatformAdminTable.role,
        PlatformAdminRoles.filter((role) => hasPlatformAdminPermission(role, "plans.manage")),
      ),
    )
    const snapshot = await batch((db) => [
      db.select().from(PlanConfigVersionTable).orderBy(desc(PlanConfigVersionTable.revision)).limit(1),
      db.select().from(PlanConfigActiveTable).where(eq(PlanConfigActiveTable.id, 1)).limit(1),
      db
        .select()
        .from(PlanConfigVersionTable)
        .where(eq(PlanConfigVersionTable.id, input.operation === "rollback" ? input.sourceVersionID : ""))
        .limit(1),
      db.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable).where(actor).limit(1),
      // D1 batch results collapse duplicate join column names; keep each table's result separate.
      db
        .select()
        .from(PlanConfigVersionTable)
        .where(
          eq(
            PlanConfigVersionTable.id,
            db
              .select({ id: PlanConfigActiveTable.active_version_id })
              .from(PlanConfigActiveTable)
              .where(eq(PlanConfigActiveTable.id, 1)),
          ),
        )
        .limit(1),
    ])
    if (!snapshot[3][0])
      throw new AdminAuthorizationError("forbidden", "Төлөвлөгөө өөрчлөх админы эрх хүрэлцэхгүй байна.")
    const current = snapshot[1][0] ? { state: snapshot[1][0], version: snapshot[4][0] } : undefined
    if (
      (snapshot[0][0]?.revision ?? 0) !== input.expectedRevision ||
      (current?.state.revision ?? null) !== input.expectedActiveStateRevision ||
      input.expectedRevision >= 2_147_483_647 ||
      (input.expectedActiveStateRevision ?? 0) >= 2_147_483_647
    ) {
      throw new PlanConfigConflictError("Төлөвлөгөөний хувилбар өөрчлөгдсөн байна")
    }
    const source = input.operation === "rollback" ? snapshot[2][0] : current?.version
    if (!source && (input.operation === "rollback" || current))
      throw new PlanConfigInvalidActiveError("Төлөвлөгөөний хувилбар олдсонгүй")
    const sourceLimits = source
      ? parseStoredPlanLimits(source.limits)
      : PlanConfig.StoredLimitsSchema.parse(
          stripCheckHeaders((dependencies.bootstrap ?? Subscription.getBootstrapLimits)()),
        )
    const version = {
      id: ulid(),
      revision: input.expectedRevision + 1,
      limits: input.operation === "update" ? inputLimits(input, sourceLimits.lite) : sourceLimits,
      created_by: admin.id,
      source_version_id: input.operation === "rollback" ? input.sourceVersionID : null,
      note: input.note,
    }
    const activation = {
      id: 1,
      active_version_id: version.id,
      revision: (input.expectedActiveStateRevision ?? 0) + 1,
      updated_by: admin.id,
      time_updated: new Date(Math.max(Date.now(), (current?.state.time_updated.getTime() ?? 0) + 1)),
    }
    await batch((db) => {
      const sameActive = current
        ? and(
            eq(PlanConfigActiveTable.id, 1),
            eq(PlanConfigActiveTable.active_version_id, current.state.active_version_id),
            eq(PlanConfigActiveTable.revision, current.state.revision),
            eq(PlanConfigActiveTable.time_updated, current.state.time_updated),
            eq(PlanConfigActiveTable.updated_by, current.state.updated_by),
          )
        : eq(PlanConfigActiveTable.id, 1)
      return [
        paymentBatchGuard(
          db,
          and(
            exists(db.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable).where(actor)),
            sql`(select coalesce(max(${PlanConfigVersionTable.revision}), 0) from ${PlanConfigVersionTable}) = ${input.expectedRevision}`,
            current
              ? exists(db.select({ id: PlanConfigActiveTable.id }).from(PlanConfigActiveTable).where(sameActive))
              : notExists(db.select({ id: PlanConfigActiveTable.id }).from(PlanConfigActiveTable).where(sameActive)),
            source
              ? exists(
                  db
                    .select({ id: PlanConfigVersionTable.id })
                    .from(PlanConfigVersionTable)
                    .where(
                      and(eq(PlanConfigVersionTable.id, source.id), eq(PlanConfigVersionTable.limits, source.limits)),
                    ),
                )
              : sql`1 = 1`,
          ),
        ),
        db.insert(PlanConfigVersionTable).values(version),
        paymentBatchGuard(db, sql`changes() = 1`),
        current
          ? db.update(PlanConfigActiveTable).set(activation).where(sameActive)
          : db.insert(PlanConfigActiveTable).values(activation),
        paymentBatchGuard(db, sql`changes() = 1`),
        paymentBatchGuard(
          db,
          exists(
            db
              .select({ id: PlanConfigActiveTable.id })
              .from(PlanConfigActiveTable)
              .where(
                and(
                  eq(PlanConfigActiveTable.id, 1),
                  eq(PlanConfigActiveTable.active_version_id, version.id),
                  eq(PlanConfigActiveTable.revision, activation.revision),
                  eq(PlanConfigActiveTable.updated_by, admin.id),
                  eq(PlanConfigActiveTable.time_updated, activation.time_updated),
                ),
              ),
          ),
        ),
        adminAuditQuery(db, {
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
        }),
      ]
    })
    return {
      ok: true as const,
      message:
        input.operation === "update"
          ? "Төлөвлөгөөний шинэ хувилбар идэвхжлээ."
          : "Сонгосон хувилбараас шинэ буцаалтын хувилбар үүсгэж идэвхжүүллээ.",
      versionID: version.id,
      revision: version.revision,
    }
  } catch (error) {
    const failure = mutationFailure(error)
    try {
      await batch((db) => [
        adminAuditQuery(db, {
          adminID: context.id,
          actorEmail: context.email,
          action: operation === "rollback" ? "plans.rollback" : "plans.update",
          outcome: failure.outcome,
          request,
          targetType: "plan_config",
          metadata: { operation, reason: failure.code },
        }),
      ])
    } catch {
      return {
        ok: false as const,
        message: "Үйлдлийн үр дүнг баталгаажуулж чадсангүй. Хуудсаа шинэчилж идэвхтэй багцын тохиргоог шалгана уу.",
      }
    }
    return { ok: false as const, message: failure.message }
  }
}

function parseStoredPlanLimits(value: unknown) {
  try {
    return PlanConfig.StoredLimitsSchema.parse(typeof value === "string" ? JSON.parse(value) : value)
  } catch (error) {
    throw new PlanConfigInvalidActiveError("Төлөвлөгөөний хувилбар хүчинтэй биш байна", { cause: error })
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
  return {
    outcome: "failure" as const,
    code: "internal_error",
    message:
      "Үйлдлийн үр дүн тодорхойгүй байна. Дахин оролдохын өмнө хуудсаа шинэчилж идэвхтэй багцын тохиргоог шалгана уу.",
  }
}

function iso(value: Date | string | number) {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}
