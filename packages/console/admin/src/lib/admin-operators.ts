import { and, asc, Database, eq, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import {
  isPlatformAdminAssignableRole,
  normalizePlatformAdminEmail,
  PlatformAdminAssignableRoles,
} from "@mongolgpt/console-core/platform-admin.js"
import { PlatformAdminTable } from "@mongolgpt/console-core/schema/admin.sql.js"
import { ulid } from "ulid"
import { z } from "zod"
import type { PlatformAdminContext } from "./admin-context"
import {
  AdminAuthorizationError,
  requirePlatformAdminOwner,
  writeAdminAudit,
  writeAdminAuditWithDb,
} from "./admin-auth"
import { loadAdminAccessConfig } from "./access"
import { AdminMutationRequestError, requireSameOriginAdminMutation } from "./admin-mutation"

const operatorID = z.string().regex(/^adm_[0-9A-HJKMNP-TV-Z]{26}$/)
const assignableRole = z.enum(PlatformAdminAssignableRoles)
const normalizedOperatorEmail = z.string().transform((value, context) => {
  try {
    return normalizePlatformAdminEmail(value)
  } catch {
    context.addIssue({ code: "custom", message: "Админы имэйл хаяг буруу байна." })
    return z.NEVER
  }
})

export const AdminOperatorMutationInput = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    email: normalizedOperatorEmail,
    role: assignableRole,
  }),
  z.object({
    operation: z.literal("update_role"),
    operatorID,
    role: assignableRole,
  }),
  z.object({
    operation: z.literal("suspend"),
    operatorID,
  }),
  z.object({
    operation: z.literal("reactivate"),
    operatorID,
  }),
])

type OperatorMutation = z.infer<typeof AdminOperatorMutationInput>

export async function listAdminOperators(context: PlatformAdminContext) {
  const admin = requirePlatformAdminOwner(context)
  const accessEmails = loadAdminAccessConfig().bootstrapEmails
  return Database.use(async (tx) => {
    const operators = await tx
      .select({
        id: PlatformAdminTable.id,
        email: PlatformAdminTable.email,
        role: PlatformAdminTable.role,
        status: PlatformAdminTable.status,
        timeCreated: PlatformAdminTable.timeCreated,
        timeLastSeen: PlatformAdminTable.time_last_seen,
      })
      .from(PlatformAdminTable)
      .where(isNull(PlatformAdminTable.timeDeleted))
      .orderBy(asc(PlatformAdminTable.email))

    return {
      admin,
      operators: operators.map((operator) => ({
        ...operator,
        timeCreated: operator.timeCreated.toISOString(),
        timeLastSeen: operator.timeLastSeen?.toISOString() ?? null,
        accessAllowed: accessEmails.has(operator.email),
        mutable: operator.id !== admin.id && operator.role !== "owner",
      })),
    }
  })
}

export async function mutateAdminOperator(context: PlatformAdminContext, request: Request, raw: unknown) {
  const targetID = readOperatorID(raw)
  const action = auditAction(raw)

  try {
    requireSameOriginAdminMutation(request)
    const admin = requirePlatformAdminOwner(context)
    const input = AdminOperatorMutationInput.parse(raw)
    const accessEmails = loadAdminAccessConfig().bootstrapEmails
    return await Database.transaction(async (tx) => {
      await requireActiveOwner(tx, admin)
      const result = await applyOperatorMutation(tx, admin, request, input, accessEmails)
      return { ok: true as const, ...result }
    })
  } catch (error) {
    const failure = mutationFailure(error)
    try {
      await writeAdminAudit({
        adminID: context.id,
        actorEmail: context.email,
        action,
        outcome: failure.outcome,
        request,
        targetType: "platform_admin",
        targetID,
        metadata: { reason: failure.code },
      })
    } catch {
      return {
        ok: false as const,
        message: "Үйлдлийг аюулгүйгээр бүртгэж чадсангүй. Ямар ч өөрчлөлт хийгдээгүй.",
      }
    }
    return { ok: false as const, message: failure.message }
  }
}

async function applyOperatorMutation(
  tx: Database.TxOrDb,
  admin: PlatformAdminContext,
  request: Request,
  input: OperatorMutation,
  accessEmails: ReadonlySet<string>,
) {
  if (input.operation === "create") {
    const email = input.email
    const accessError = evaluateAdminOperatorAccessEligibility(email, accessEmails)
    if (accessError) throw new AdminOperatorMutationError(accessError)
    const existing = await tx
      .select({ id: PlatformAdminTable.id })
      .from(PlatformAdminTable)
      .where(eq(PlatformAdminTable.email, email))
      .limit(1)
      .then((rows) => rows[0])
    if (existing) throw new AdminOperatorMutationError("email_exists")

    const operator = {
      id: `adm_${ulid()}`,
      email,
      access_subject: null,
      role: input.role,
      status: "active" as const,
      time_last_seen: null,
      timeCreated: new Date(),
      timeUpdated: new Date(),
      timeDeleted: null,
    }
    await tx.insert(PlatformAdminTable).values(operator)
    await writeAdminAuditWithDb(tx, {
      adminID: admin.id,
      actorEmail: admin.email,
      action: "admin.operator.create",
      outcome: "success",
      request,
      targetType: "platform_admin",
      targetID: operator.id,
      metadata: { email, role: operator.role, status: operator.status },
    })
    return { message: "Шинэ операторыг идэвхтэй эрхтэйгээр нэмлээ." }
  }

  const target = await tx
    .select({
      id: PlatformAdminTable.id,
      email: PlatformAdminTable.email,
      role: PlatformAdminTable.role,
      status: PlatformAdminTable.status,
    })
    .from(PlatformAdminTable)
    .where(and(eq(PlatformAdminTable.id, input.operatorID), isNull(PlatformAdminTable.timeDeleted)))
    .limit(1)
    .then((rows) => rows[0])
  if (!target) throw new AdminOperatorMutationError("not_found")
  const targetMutationError = evaluateAdminOperatorTargetMutation(admin.id, target)
  if (targetMutationError) throw new AdminOperatorMutationError(targetMutationError)

  if (input.operation === "reactivate") {
    const accessError = evaluateAdminOperatorAccessEligibility(target.email, accessEmails)
    if (accessError) throw new AdminOperatorMutationError(accessError)
  }

  if (input.operation === "update_role") {
    const updated = await tx
      .update(PlatformAdminTable)
      .set({ role: input.role, timeUpdated: new Date() })
      .where(
        and(
          eq(PlatformAdminTable.id, target.id),
          eq(PlatformAdminTable.role, target.role),
          eq(PlatformAdminTable.status, target.status),
          isNull(PlatformAdminTable.timeDeleted),
        ),
      )
    if (resultChanges(updated) !== 1) throw new AdminOperatorMutationError("conflict")
    await writeAdminAuditWithDb(tx, {
      adminID: admin.id,
      actorEmail: admin.email,
      action: "admin.operator.role_update",
      outcome: "success",
      request,
      targetType: "platform_admin",
      targetID: target.id,
      metadata: { email: target.email, before_role: target.role, after_role: input.role },
    })
    return { message: "Операторын эрхийг шинэчиллээ." }
  }

  const status = input.operation === "suspend" ? "suspended" : "active"
  const updated = await tx
    .update(PlatformAdminTable)
    .set({ status, timeUpdated: new Date() })
    .where(
      and(
        eq(PlatformAdminTable.id, target.id),
        eq(PlatformAdminTable.role, target.role),
        eq(PlatformAdminTable.status, target.status),
        isNull(PlatformAdminTable.timeDeleted),
      ),
    )
  if (resultChanges(updated) !== 1) throw new AdminOperatorMutationError("conflict")
  await writeAdminAuditWithDb(tx, {
    adminID: admin.id,
    actorEmail: admin.email,
    action: `admin.operator.${input.operation}`,
    outcome: "success",
    request,
    targetType: "platform_admin",
    targetID: target.id,
    metadata: { email: target.email, before_status: target.status, after_status: status },
  })
  return {
    message: status === "suspended" ? "Операторын эрхийг түр түдгэлзүүллээ." : "Операторын эрхийг дахин идэвхжүүллээ.",
  }
}

async function requireActiveOwner(tx: Database.TxOrDb, admin: PlatformAdminContext) {
  const actor = await tx
    .select({ id: PlatformAdminTable.id, role: PlatformAdminTable.role, status: PlatformAdminTable.status })
    .from(PlatformAdminTable)
    .where(and(eq(PlatformAdminTable.id, admin.id), isNull(PlatformAdminTable.timeDeleted)))
    .limit(1)
    .then((rows) => rows[0])
  if (!actor || actor.role !== "owner" || actor.status !== "active") {
    throw new AdminOperatorMutationError("owner_invariant")
  }
}

export function evaluateAdminOperatorTargetMutation(actorID: string, target: { id: string; role: string }) {
  if (target.id === actorID) return "self_change" as const
  if (target.role === "owner") return "owner_protected" as const
  return undefined
}

export function evaluateAdminOperatorAccessEligibility(email: string, accessEmails: ReadonlySet<string>) {
  if (!accessEmails.has(email)) return "access_not_allowed" as const
  return undefined
}

function readOperatorID(raw: unknown) {
  if (typeof raw !== "object" || raw === null || !("operatorID" in raw) || typeof raw.operatorID !== "string") {
    return undefined
  }
  return raw.operatorID.slice(0, 30)
}

function auditAction(raw: unknown) {
  if (typeof raw !== "object" || raw === null || !("operation" in raw)) return "admin.operator.mutation"
  if (raw.operation === "create") return "admin.operator.create"
  if (raw.operation === "update_role") return "admin.operator.role_update"
  if (raw.operation === "suspend") return "admin.operator.suspend"
  if (raw.operation === "reactivate") return "admin.operator.reactivate"
  return "admin.operator.mutation"
}

function mutationFailure(error: unknown) {
  if (error instanceof AdminMutationRequestError) {
    return { outcome: "denied" as const, code: `request_${error.code}`, message: "Аюулгүй байдлын хүсэлтийн шалгалт амжилтгүй боллоо." }
  }
  if (error instanceof AdminAuthorizationError) {
    return { outcome: "denied" as const, code: error.code, message: error.message }
  }
  if (error instanceof z.ZodError) {
    return { outcome: "denied" as const, code: "invalid_input", message: "Операторын мэдээлэл эсвэл үйлдэл буруу байна." }
  }
  if (error instanceof AdminOperatorMutationError) {
    return { outcome: "denied" as const, code: error.code, message: operatorErrorMessage(error.code) }
  }
  return { outcome: "failure" as const, code: "internal_error", message: "Операторын эрх өөрчлөх үед алдаа гарлаа." }
}

function operatorErrorMessage(code: AdminOperatorMutationError["code"]) {
  if (code === "email_exists") return "Энэ имэйлтэй админ бүртгэл аль хэдийн байна."
  if (code === "access_not_allowed") {
    return "Энэ имэйл Cloudflare Access-ийн зөвшөөрөгдсөн жагсаалтад алга. Эхлээд MONGOLGPT_ADMIN_BOOTSTRAP_EMAILS нууц утгад нэмээд админ орчныг дахин байршуулна уу."
  }
  if (code === "self_change") return "Өөрийн эрх эсвэл төлөвийг энэ хуудсаар өөрчлөх боломжгүй."
  if (code === "owner_protected") return "Эзэмшигчийн эрх болон төлөвийг энэ хуудсаар өөрчлөх боломжгүй."
  if (code === "owner_invariant") return "Идэвхтэй эзэмшигчийн хамгаалалт зөрчигдсөн тул үйлдлийг зогсоолоо."
  if (code === "conflict") return "Операторын мэдээлэл зэрэг өөрчлөгдсөн байна. Хуудсаа шинэчлээд дахин оролдоно уу."
  return "Удирдах оператор олдсонгүй."
}

export function isAssignableOperatorRole(value: unknown) {
  return isPlatformAdminAssignableRole(value)
}

export class AdminOperatorMutationError extends Error {
  constructor(
    readonly code:
      | "access_not_allowed"
      | "email_exists"
      | "not_found"
      | "self_change"
      | "owner_protected"
      | "owner_invariant"
      | "conflict",
  ) {
    super(code)
    this.name = "AdminOperatorMutationError"
  }
}

function resultChanges(result: unknown) {
  if (!result || typeof result !== "object") return 0
  if ("meta" in result && result.meta && typeof result.meta === "object" && "changes" in result.meta) {
    return Number(result.meta.changes ?? 0)
  }
  if ("changes" in result) return Number(result.changes ?? 0)
  return 0
}
