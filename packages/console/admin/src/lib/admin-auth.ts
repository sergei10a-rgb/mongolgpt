import {
  and,
  count,
  Database,
  eq,
  isNull,
} from "@mongolgpt/console-core/drizzle/index.js"
import {
  hasPlatformAdminPermission,
  isPlatformAdminRole,
  PlatformAdminPermissions,
} from "@mongolgpt/console-core/platform-admin.js"
import type { PlatformAdminPermission } from "@mongolgpt/console-core/platform-admin.js"
import {
  AdminAuditLogTable,
  PlatformAdminTable,
} from "@mongolgpt/console-core/schema/admin.sql.js"
import { ulid } from "ulid"
import type { AdminAccessConfig, CloudflareAccessIdentity } from "./access"
import type { PlatformAdminContext } from "./admin-context"

type AuditMetadata = Record<string, string | number | boolean | null>

export interface AdminAuditInput {
  adminID?: string
  actorEmail: string
  action: string
  outcome: "success" | "denied" | "failure"
  request: Request
  targetType?: string
  targetID?: string
  metadata?: AuditMetadata
}

export class AdminAuthorizationError extends Error {
  constructor(
    readonly code: "not_registered" | "suspended" | "subject_mismatch" | "invalid_role" | "forbidden",
    message: string,
  ) {
    super(message)
    this.name = "AdminAuthorizationError"
  }
}

export async function authorizePlatformAdmin(
  identity: CloudflareAccessIdentity,
  config: AdminAccessConfig,
  request: Request,
): Promise<PlatformAdminContext> {
  const decision = await Database.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(PlatformAdminTable)
      .where(and(eq(PlatformAdminTable.email, identity.email), isNull(PlatformAdminTable.timeDeleted)))
      .limit(1)
      .then((rows) => rows[0])

    if (!existing) {
      const total = await tx
        .select({ value: count() })
        .from(PlatformAdminTable)
        .where(isNull(PlatformAdminTable.timeDeleted))
        .then((rows) => rows[0]?.value ?? 0)
      if (!canBootstrapFirstOwner(total, config.bootstrapEmails, identity.email)) {
        return {
          allowed: false as const,
          code: "not_registered" as const,
          message: "Энэ бүртгэлд MongolGPT админы эрх олгогдоогүй байна.",
        }
      }

      const admin = {
        id: `adm_${ulid()}`,
        email: identity.email,
        access_subject: identity.subject,
        role: "owner" as const,
        status: "active" as const,
        time_last_seen: new Date(),
        timeCreated: new Date(),
        timeUpdated: new Date(),
        timeDeleted: null,
      }
      await tx.insert(PlatformAdminTable).values(admin)
      await insertAdminAudit(tx, {
        adminID: admin.id,
        actorEmail: admin.email,
        action: "admin.bootstrap_owner",
        outcome: "success",
        request,
        targetType: "platform_admin",
        targetID: admin.id,
      })
      return {
        allowed: true as const,
        admin,
        bootstrapped: true,
      }
    }

    const existingDecision = evaluateExistingPlatformAdmin(existing, identity.subject)
    if (!existingDecision.allowed) {
      return {
        allowed: false as const,
        code: existingDecision.code,
        message: existingDecision.message,
        adminID: existing.id,
      }
    }

    await tx
      .update(PlatformAdminTable)
      .set({
        access_subject: identity.subject,
        time_last_seen: new Date(),
        timeUpdated: new Date(),
      })
      .where(eq(PlatformAdminTable.id, existing.id))

    return {
      allowed: true as const,
      admin: {
        ...existing,
        access_subject: identity.subject,
        time_last_seen: new Date(),
      },
      bootstrapped: false,
    }
  })

  if (!decision.allowed) {
    await writeAdminAudit({
      adminID: decision.adminID,
      actorEmail: identity.email,
      action: "admin.authorization",
      outcome: "denied",
      request,
      targetType: "route",
      targetID: requestTarget(request),
      metadata: {
        reason: decision.code,
      },
    })
    throw new AdminAuthorizationError(decision.code, decision.message)
  }

  const role = decision.admin.role
  if (!isPlatformAdminRole(role)) {
    throw new AdminAuthorizationError("invalid_role", "Админы role тохиргоо хүчингүй байна.")
  }
  return {
    id: decision.admin.id,
    email: decision.admin.email,
    subject: identity.subject,
    role,
    permissions: PlatformAdminPermissions.filter((permission) =>
      hasPlatformAdminPermission(role, permission),
    ),
    requestID: requestID(request),
    bootstrapped: decision.bootstrapped,
  }
}

export function canBootstrapFirstOwner(
  existingAdminCount: number,
  bootstrapEmails: ReadonlySet<string>,
  email: string,
) {
  return existingAdminCount === 0 && bootstrapEmails.has(email)
}

export function evaluateExistingPlatformAdmin(
  admin: {
    status: unknown
    role: unknown
    access_subject: string | null
  },
  subject: string,
) {
  if (admin.status !== "active") {
    return {
      allowed: false as const,
      code: "suspended" as const,
      message: "Админы эрх түр түдгэлзсэн байна.",
    }
  }
  if (!isPlatformAdminRole(admin.role)) {
    return {
      allowed: false as const,
      code: "invalid_role" as const,
      message: "Админы role тохиргоо хүчингүй байна.",
    }
  }
  if (admin.access_subject && admin.access_subject !== subject) {
    return {
      allowed: false as const,
      code: "subject_mismatch" as const,
      message: "Cloudflare Access бүртгэл админы бүртгэлтэй таарахгүй байна.",
    }
  }
  return {
    allowed: true as const,
    role: admin.role,
    bindSubject: !admin.access_subject,
  }
}

export function requirePlatformAdminPermission(
  context: PlatformAdminContext,
  permission: PlatformAdminPermission,
) {
  if (context.permissions.includes(permission)) return context
  throw new AdminAuthorizationError("forbidden", "Энэ үйлдлийг хийх админы эрх хүрэлцэхгүй байна.")
}

export async function writeAdminAudit(input: AdminAuditInput) {
  await Database.use((tx) => insertAdminAudit(tx, input))
}

export function requestID(request: Request) {
  return (request.headers.get("cf-ray")?.trim() || crypto.randomUUID()).slice(0, 128)
}

export function requestTarget(request: Request) {
  const url = new URL(request.url)
  return `${request.method.toUpperCase()} ${url.pathname}`.slice(0, 255)
}

async function insertAdminAudit(tx: Database.TxOrDb, input: AdminAuditInput) {
  await tx.insert(AdminAuditLogTable).values({
    id: `aud_${ulid()}`,
    admin_id: input.adminID,
    actor_email: input.actorEmail,
    action: input.action.slice(0, 128),
    target_type: input.targetType?.slice(0, 64),
    target_id: input.targetID?.slice(0, 255),
    outcome: input.outcome,
    request_id: requestID(input.request),
    source_ip: input.request.headers.get("cf-connecting-ip")?.slice(0, 45),
    user_agent: input.request.headers.get("user-agent")?.slice(0, 512),
    metadata: input.metadata,
    time_created: new Date(),
  })
}
