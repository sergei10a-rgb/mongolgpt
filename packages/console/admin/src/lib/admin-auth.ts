import {
  and,
  Database,
  eq,
  exists,
  inArray,
  isNull,
  notExists,
  or,
  sql,
} from "@mongolgpt/console-core/drizzle/index.js"
import type { SQL } from "@mongolgpt/console-core/drizzle/index.js"
import {
  hasPlatformAdminPermission,
  isPlatformAdminRole,
  PlatformAdminPermissions,
} from "@mongolgpt/console-core/platform-admin.js"
import type { PlatformAdminPermission } from "@mongolgpt/console-core/platform-admin.js"
import { AdminAuditLogTable, PlatformAdminRoles, PlatformAdminTable } from "@mongolgpt/console-core/schema/admin.sql.js"
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
  dependencies: { batch?: typeof Database.batch } = {},
): Promise<PlatformAdminContext> {
  const batch = dependencies.batch ?? Database.batch
  const bootstrapID = `adm_${ulid()}`
  const now = Date.now()
  // A single D1 batch serializes first-owner creation, subject binding and the returned live permissions.
  // Deleted administrators still close bootstrap: deleting the last owner must not reopen self-registration.
  const result = await batch((tx) => [
    tx.insert(PlatformAdminTable).select(
      tx
        .select({
          id: sql`${bootstrapID}`.as("id"),
          email: sql`${identity.email}`.as("email"),
          access_subject: sql`${identity.subject}`.as("access_subject"),
          role: sql`'owner'`.as("role"),
          status: sql`'active'`.as("status"),
          time_last_seen: sql`${now}`.as("time_last_seen"),
          timeCreated: sql`${now}`.as("time_created"),
          timeUpdated: sql`${now}`.as("time_updated"),
          timeDeleted: sql`null`.as("time_deleted"),
        })
        .from(sql`(select 1)`)
        .where(
          and(
            sql`${canBootstrapFirstOwner(0, config.bootstrapEmails, identity.email) ? 1 : 0} = 1`,
            notExists(tx.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable)),
          ),
        ),
    ),
    adminAuditQuery(
      tx,
      {
        adminID: bootstrapID,
        actorEmail: identity.email,
        action: "admin.bootstrap_owner",
        outcome: "success",
        request,
        targetType: "platform_admin",
        targetID: bootstrapID,
      },
      exists(
        tx.select({ id: PlatformAdminTable.id }).from(PlatformAdminTable).where(eq(PlatformAdminTable.id, bootstrapID)),
      ),
    ),
    tx
      .update(PlatformAdminTable)
      .set({
        access_subject: identity.subject,
        time_last_seen: sql`max(coalesce(${PlatformAdminTable.time_last_seen}, 0), ${now})`,
        timeUpdated: sql`max(${PlatformAdminTable.timeUpdated}, ${now})`,
      })
      .where(
        and(
          eq(PlatformAdminTable.email, identity.email),
          isNull(PlatformAdminTable.timeDeleted),
          eq(PlatformAdminTable.status, "active"),
          inArray(PlatformAdminTable.role, [...PlatformAdminRoles]),
          or(
            isNull(PlatformAdminTable.access_subject),
            eq(PlatformAdminTable.access_subject, ""),
            eq(PlatformAdminTable.access_subject, identity.subject),
          ),
        ),
      ),
    tx
      .select()
      .from(PlatformAdminTable)
      .where(and(eq(PlatformAdminTable.email, identity.email), isNull(PlatformAdminTable.timeDeleted)))
      .limit(1),
  ])
  const admin = result[3][0]
  const decision = admin
    ? evaluateExistingPlatformAdmin(admin, identity.subject)
    : {
        allowed: false as const,
        code: "not_registered" as const,
        message: "Энэ бүртгэлд MongolGPT админы эрх олгогдоогүй байна.",
      }

  if (!decision.allowed) {
    await batch((tx) => [
      adminAuditQuery(tx, {
        adminID: admin?.id,
        actorEmail: identity.email,
        action: "admin.authorization",
        outcome: "denied",
        request,
        targetType: "route",
        targetID: requestTarget(request),
        metadata: {
          reason: decision.code,
        },
      }),
    ])
    throw new AdminAuthorizationError(decision.code, decision.message)
  }

  const role = admin?.role
  if (!admin || !isPlatformAdminRole(role)) {
    throw new AdminAuthorizationError("invalid_role", "Админы role тохиргоо хүчингүй байна.")
  }
  return {
    id: admin.id,
    email: admin.email,
    subject: identity.subject,
    role,
    permissions: PlatformAdminPermissions.filter((permission) => hasPlatformAdminPermission(role, permission)),
    requestID: requestID(request),
    bootstrapped: admin.id === bootstrapID,
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

export function requirePlatformAdminPermission(context: PlatformAdminContext, permission: PlatformAdminPermission) {
  if (context.permissions.includes(permission)) return context
  throw new AdminAuthorizationError("forbidden", "Энэ үйлдлийг хийх админы эрх хүрэлцэхгүй байна.")
}

export function requirePlatformAdminOwner(context: PlatformAdminContext) {
  requirePlatformAdminPermission(context, "admins.manage")
  if (context.role !== "owner") {
    throw new AdminAuthorizationError("forbidden", "Энэ үйлдлийг зөвхөн платформын эзэмшигч хийж болно.")
  }
  return context
}

export async function writeAdminAudit(input: AdminAuditInput) {
  await Database.use((tx) => writeAdminAuditWithDb(tx, input))
}

export function requestID(request: Request) {
  return (request.headers.get("cf-ray")?.trim() || crypto.randomUUID()).slice(0, 128)
}

export function requestTarget(request: Request) {
  const url = new URL(request.url)
  return `${request.method.toUpperCase()} ${url.pathname}`.slice(0, 255)
}

export async function writeAdminAuditWithDb(tx: Database.TxOrDb, input: AdminAuditInput) {
  await adminAuditQuery(tx, input)
}

export function adminAuditQuery(tx: Database.TxOrDb, input: AdminAuditInput, condition?: SQL) {
  const values = {
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
  }
  if (!condition) return tx.insert(AdminAuditLogTable).values(values)
  return tx.insert(AdminAuditLogTable).select(
    tx
      .select({
        id: sql`${values.id}`.as("id"),
        admin_id: sql`${values.admin_id ?? null}`.as("admin_id"),
        actor_email: sql`${values.actor_email}`.as("actor_email"),
        action: sql`${values.action}`.as("action"),
        target_type: sql`${values.target_type ?? null}`.as("target_type"),
        target_id: sql`${values.target_id ?? null}`.as("target_id"),
        outcome: sql`${values.outcome}`.as("outcome"),
        request_id: sql`${values.request_id}`.as("request_id"),
        source_ip: sql`${values.source_ip ?? null}`.as("source_ip"),
        user_agent: sql`${values.user_agent ?? null}`.as("user_agent"),
        metadata: sql`${values.metadata === undefined ? null : JSON.stringify(values.metadata)}`.as("metadata"),
        time_created: sql`${values.time_created.getTime()}`.as("time_created"),
      })
      .from(sql`(select 1)`)
      .where(condition),
  )
}
