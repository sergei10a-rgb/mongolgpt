import { z } from "zod"
import { and, Database, desc, eq, lt, sql } from "@mongolgpt/console-core/drizzle/index.js"
import { AdminAuditLogTable } from "@mongolgpt/console-core/schema/admin.sql.js"
import type { PlatformAdminContext } from "./admin-context"
import { requirePlatformAdminPermission } from "./admin-auth"

const auditID = z.string().regex(/^aud_[0-9A-HJKMNP-TV-Z]{26}$/)

export const AdminAuditDirectoryInput = z.object({
  q: z.string().trim().max(100).default(""),
  outcome: z.enum(["all", "success", "denied", "failure"]).default("all"),
  cursor: auditID.optional(),
  limit: z.union([z.literal(25), z.literal(50)]).default(25),
})

export async function listAdminAudit(context: PlatformAdminContext, raw: unknown) {
  const admin = requirePlatformAdminPermission(context, "audit.read")
  const input = AdminAuditDirectoryInput.parse(raw)
  const pattern = input.q ? `%${escapeLike(input.q.toLowerCase())}%` : undefined

  return Database.use(async (tx) => {
    const fetched = await tx
      .select({
        id: AdminAuditLogTable.id,
        actor: AdminAuditLogTable.actor_email,
        action: AdminAuditLogTable.action,
        targetType: AdminAuditLogTable.target_type,
        targetID: AdminAuditLogTable.target_id,
        outcome: AdminAuditLogTable.outcome,
        requestID: AdminAuditLogTable.request_id,
        sourceIP: AdminAuditLogTable.source_ip,
        time: AdminAuditLogTable.time_created,
      })
      .from(AdminAuditLogTable)
      .where(
        and(
          input.outcome === "all" ? undefined : eq(AdminAuditLogTable.outcome, input.outcome),
          input.cursor ? lt(AdminAuditLogTable.id, input.cursor) : undefined,
          pattern
            ? sql<boolean>`(
                lower(${AdminAuditLogTable.actor_email}) like ${pattern} escape '\'
                or lower(${AdminAuditLogTable.action}) like ${pattern} escape '\'
                or lower(coalesce(${AdminAuditLogTable.target_type}, '')) like ${pattern} escape '\'
                or lower(coalesce(${AdminAuditLogTable.target_id}, '')) like ${pattern} escape '\'
                or lower(${AdminAuditLogTable.request_id}) like ${pattern} escape '\'
              )`
            : undefined,
        ),
      )
      .orderBy(desc(AdminAuditLogTable.id))
      .limit(input.limit + 1)

    const entries = fetched.slice(0, input.limit)
    return {
      admin,
      filters: input,
      entries: entries.map((entry) => ({
        ...entry,
        time: entry.time.toISOString(),
      })),
      nextCursor: fetched.length > input.limit ? entries.at(-1)?.id : undefined,
    }
  })
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}
