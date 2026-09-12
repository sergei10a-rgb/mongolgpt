import { and, asc, Database, eq, exists, isNull, notExists, sql } from "@mongolgpt/console-core/drizzle/index.js"
import { paymentBatchGuard } from "@mongolgpt/console-core/payment-ledger.js"
import {
  isPlatformAdminAssignableRole,
  normalizePlatformAdminEmail,
  PlatformAdminAssignableRoles,
} from "@mongolgpt/console-core/platform-admin.js"
import { PlatformAdminTable } from "@mongolgpt/console-core/schema/admin.sql.js"
import { ulid } from "ulid"
import { z } from "zod"
import type { PlatformAdminContext } from "./admin-context"
import { AdminAuthorizationError, requirePlatformAdminOwner, adminAuditQuery } from "./admin-auth"
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

export async function mutateAdminOperator(
  context: PlatformAdminContext,
  request: Request,
  raw: unknown,
  dependencies: { batch?: typeof Database.batch; accessEmails?: ReadonlySet<string> } = {},
) {
  const batch = dependencies.batch ?? Database.batch
  const targetID = readOperatorID(raw)
  const action = auditAction(raw)

  try {
    requireSameOriginAdminMutation(request)
    const admin = requirePlatformAdminOwner(context)
    const input = AdminOperatorMutationInput.parse(raw)
    const accessEmails = dependencies.accessEmails ?? loadAdminAccessConfig().bootstrapEmails
    const result = await applyOperatorMutation(batch, admin, request, input, accessEmails)
    return { ok: true as const, ...result }
  } catch (error) {
    const failure = mutationFailure(error)
    try {
      await batch((tx) => [
        adminAuditQuery(tx, {
          adminID: context.id,
          actorEmail: context.email,
          action,
          outcome: failure.outcome,
          request,
          targetType: "platform_admin",
          targetID,
          metadata: { reason: failure.code },
        }),
      ])
    } catch {
      return {
        ok: false as const,
        message: "Үйлдлийн үр дүнг баталгаажуулж чадсангүй. Хуудсаа шинэчилж операторын төлөвийг шалгана уу.",
      }
    }
    return { ok: false as const, message: failure.message }
  }
}

async function applyOperatorMutation(
  batch: typeof Database.batch,
  admin: PlatformAdminContext,
  request: Request,
  input: OperatorMutation,
  accessEmails: ReadonlySet<string>,
) {
  const currentOwner = and(
    eq(PlatformAdminTable.id, admin.id),
    eq(PlatformAdminTable.email, admin.email),
    eq(PlatformAdminTable.access_subject, admin.subject),
    eq(PlatformAdminTable.role, "owner"),
    eq(PlatformAdminTable.status, "active"),
    isNull(PlatformAdminTable.timeDeleted),
  )
  const snapshot = await batch((tx) => [
    tx.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable).where(currentOwner).limit(1),
    tx
      .select()
      .from(PlatformAdminTable)
      .where(
        input.operation === "create"
          ? eq(PlatformAdminTable.email, input.email)
          : and(eq(PlatformAdminTable.id, input.operatorID), isNull(PlatformAdminTable.timeDeleted)),
      )
      .limit(1),
  ])
  if (!snapshot[0][0]) throw new AdminOperatorMutationError("owner_invariant")
  const target = snapshot[1][0]

  if (input.operation === "create") {
    const email = input.email
    const accessError = evaluateAdminOperatorAccessEligibility(email, accessEmails)
    if (accessError) throw new AdminOperatorMutationError(accessError)
    if (target) throw new AdminOperatorMutationError("email_exists")

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
    await batch((tx) => [
      paymentBatchGuard(
        tx,
        and(
          exists(tx.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable).where(currentOwner)),
          notExists(
            tx
              .select({ id: PlatformAdminTable.id })
              .from(PlatformAdminTable)
              .where(eq(PlatformAdminTable.email, email)),
          ),
        ),
      ),
      tx.insert(PlatformAdminTable).values(operator),
      paymentBatchGuard(tx, sql`changes() = 1`),
      adminAuditQuery(tx, {
        adminID: admin.id,
        actorEmail: admin.email,
        action: "admin.operator.create",
        outcome: "success",
        request,
        targetType: "platform_admin",
        targetID: operator.id,
        metadata: { email, role: operator.role, status: operator.status },
      }),
    ])
    return { message: "Шинэ операторыг идэвхтэй эрхтэйгээр нэмлээ." }
  }

  if (!target) throw new AdminOperatorMutationError("not_found")
  const targetMutationError = evaluateAdminOperatorTargetMutation(admin.id, target)
  if (targetMutationError) throw new AdminOperatorMutationError(targetMutationError)

  if (input.operation === "reactivate") {
    const accessError = evaluateAdminOperatorAccessEligibility(target.email, accessEmails)
    if (accessError) throw new AdminOperatorMutationError(accessError)
  }

  const status = input.operation === "suspend" ? "suspended" : "active"
  const sameTarget = and(
    eq(PlatformAdminTable.id, target.id),
    eq(PlatformAdminTable.email, target.email),
    eq(PlatformAdminTable.role, target.role),
    eq(PlatformAdminTable.status, target.status),
    eq(PlatformAdminTable.timeUpdated, target.timeUpdated),
    target.access_subject === null
      ? isNull(PlatformAdminTable.access_subject)
      : eq(PlatformAdminTable.access_subject, target.access_subject),
    isNull(PlatformAdminTable.timeDeleted),
  )
  // Recheck both identities inside the write batch. A monotonic timestamp fences concurrent/no-op edits.
  await batch((tx) => [
    paymentBatchGuard(
      tx,
      and(
        exists(tx.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable).where(currentOwner)),
        exists(tx.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable).where(sameTarget)),
      ),
    ),
    tx
      .update(PlatformAdminTable)
      .set({
        ...(input.operation === "update_role" ? { role: input.role } : { status }),
        timeUpdated: new Date(Math.max(Date.now(), target.timeUpdated.getTime() + 1)),
      })
      .where(sameTarget),
    paymentBatchGuard(tx, sql`changes() = 1`),
    adminAuditQuery(tx, {
      adminID: admin.id,
      actorEmail: admin.email,
      action: input.operation === "update_role" ? "admin.operator.role_update" : `admin.operator.${input.operation}`,
      outcome: "success",
      request,
      targetType: "platform_admin",
      targetID: target.id,
      metadata:
        input.operation === "update_role"
          ? { email: target.email, before_role: target.role, after_role: input.role }
          : { email: target.email, before_status: target.status, after_status: status },
    }),
  ])
  return {
    message:
      input.operation === "update_role"
        ? "Операторын эрхийг шинэчиллээ."
        : status === "suspended"
          ? "Операторын эрхийг түр түдгэлзүүллээ."
          : "Операторын эрхийг дахин идэвхжүүллээ.",
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
    return {
      outcome: "denied" as const,
      code: `request_${error.code}`,
      message: "Аюулгүй байдлын хүсэлтийн шалгалт амжилтгүй боллоо.",
    }
  }
  if (error instanceof AdminAuthorizationError) {
    return { outcome: "denied" as const, code: error.code, message: error.message }
  }
  if (error instanceof z.ZodError) {
    return {
      outcome: "denied" as const,
      code: "invalid_input",
      message: "Операторын мэдээлэл эсвэл үйлдэл буруу байна.",
    }
  }
  if (error instanceof AdminOperatorMutationError) {
    return { outcome: "denied" as const, code: error.code, message: operatorErrorMessage(error.code) }
  }
  return {
    outcome: "failure" as const,
    code: "internal_error",
    message: "Үйлдлийн үр дүн тодорхойгүй байна. Дахин оролдохын өмнө хуудсаа шинэчилж операторын төлөвийг шалгана уу.",
  }
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
