import { Database } from "@mongolgpt/console-core/drizzle/index.js"
import {
  AdminSupportMutationInputSchema,
  AdminSupportQueueInputSchema,
  SupportError,
  getAdminSupportTicketWithDb,
  listAdminSupportTicketsWithDb,
  mutateAdminSupportTicketWithDb,
} from "@mongolgpt/console-core/support.js"
import { z } from "zod"
import type { PlatformAdminContext } from "./admin-context"
import {
  AdminAuthorizationError,
  requirePlatformAdminPermission,
  writeAdminAudit,
  writeAdminAuditWithDb,
} from "./admin-auth"
import { AdminMutationRequestError, requireSameOriginAdminMutation } from "./admin-mutation"

const ticketID = z.string().regex(/^spt_[0-9A-HJKMNP-TV-Z]{26}$/)
const expectedLockVersion = z
  .object({
    expectedLockVersion: z.preprocess(
      (value) => (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value),
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ),
  })
  .strict()

export interface AdminSupportDependencies {
  transaction: typeof Database.transaction
  getAdminSupportTicketWithDb: typeof getAdminSupportTicketWithDb
  mutateAdminSupportTicketWithDb: typeof mutateAdminSupportTicketWithDb
  writeAdminAuditWithDb: typeof writeAdminAuditWithDb
  writeAdminAudit: typeof writeAdminAudit
}

const productionDependencies: AdminSupportDependencies = {
  transaction: Database.transaction,
  getAdminSupportTicketWithDb,
  mutateAdminSupportTicketWithDb,
  writeAdminAuditWithDb,
  writeAdminAudit,
}

export async function listAdminSupportQueue(context: PlatformAdminContext, raw: unknown) {
  const admin = requirePlatformAdminPermission(context, "support.read")
  const input = AdminSupportQueueInputSchema.parse(raw)
  return Database.use(async (db) => {
    const queue = await listAdminSupportTicketsWithDb(db, { ...input, adminID: admin.id })
    return { admin, ...queue }
  })
}

export async function getAdminSupportTicketDetail(context: PlatformAdminContext, ticketIDValue: string) {
  requirePlatformAdminPermission(context, "support.read")
  return Database.use((db) => getAdminSupportTicketWithDb(db, { ticketID: ticketID.parse(ticketIDValue) }))
}

export async function mutateAdminSupport(
  context: PlatformAdminContext,
  request: Request,
  raw: unknown,
  dependencies: AdminSupportDependencies = productionDependencies,
) {
  const action = auditAction(raw)
  const targetID = ticketID.safeParse(rawTicketID(raw)).data
  try {
    requireSameOriginAdminMutation(request)
    const admin = requirePlatformAdminPermission(context, "support.manage")
    const input = parseMutationInput(raw)
    return await dependencies.transaction(async (tx) => {
      const before = await dependencies.getAdminSupportTicketWithDb(tx, { ticketID: input.ticketID })
      const result = await dependencies.mutateAdminSupportTicketWithDb(tx, { ...input, adminID: admin.id })
      await dependencies.writeAdminAuditWithDb(tx, {
        adminID: admin.id,
        actorEmail: admin.email,
        action,
        outcome: "success",
        request,
        targetType: "support_ticket",
        targetID: result.id,
        metadata: {
          operation: input.operation,
          before_status: before.ticket.status,
          after_status: result.status,
          before_priority: before.ticket.priority,
          after_priority: result.priority,
          before_assigned_admin_id: before.ticket.assigned_admin_id,
          after_assigned_admin_id: result.assignedAdminID,
          lock_version: result.lockVersion,
        },
      })
      return { ok: true as const, ticket: result }
    })
  } catch (error) {
    const failure = mutationFailure(error)
    try {
      await dependencies.writeAdminAudit({
        adminID: context.id,
        actorEmail: context.email,
        action,
        outcome: failure.outcome,
        request,
        targetType: "support_ticket",
        targetID,
        metadata: { operation: rawOperation(raw), reason: failure.code },
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

function rawTicketID(raw: unknown) {
  return typeof raw === "object" && raw !== null && "ticketID" in raw && typeof raw.ticketID === "string"
    ? raw.ticketID.slice(0, 30)
    : ""
}

function parseMutationInput(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new z.ZodError([])
  const values = raw as Record<string, unknown>
  const expected = expectedLockVersion.parse({ expectedLockVersion: values.expectedLockVersion })
  return AdminSupportMutationInputSchema.parse({ ...values, ...expected })
}

function rawOperation(raw: unknown) {
  return typeof raw === "object" && raw !== null && "operation" in raw && typeof raw.operation === "string"
    ? raw.operation.slice(0, 32)
    : "unknown"
}

function auditAction(raw: unknown) {
  const operation = rawOperation(raw)
  if (operation === "reply") return "support.ticket.reply"
  if (operation === "note") return "support.ticket.note"
  if (operation === "update") return "support.ticket.update"
  return "support.ticket.mutation"
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
  if (error instanceof z.ZodError || error instanceof SupportError)
    return {
      outcome: error instanceof SupportError && error.code === "conflict" ? ("failure" as const) : ("denied" as const),
      code: error instanceof SupportError ? error.code : "invalid_input",
      message: error instanceof SupportError ? error.message : "Хүсэлтийн мэдээлэл буруу байна.",
    }
  return {
    outcome: "failure" as const,
    code: "internal_error",
    message: "Тусламжийн хүсэлтийг өөрчлөх үед алдаа гарлаа.",
  }
}
