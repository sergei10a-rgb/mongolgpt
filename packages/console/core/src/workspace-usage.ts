import { and, Database, desc, eq, isNull } from "./drizzle"
import { UsageTable } from "./schema/billing.sql"
import { Actor } from "./actor"
import { z } from "zod"

const workspaceIdentifier = z.string().trim().min(5).max(30).regex(/^wrk_/)
const pageNumber = z.number().int().min(0).max(10_000)
const pageSize = z.number().int().min(1).max(100)

export function listWorkspaceUsage(page = 0, limit = 50) {
  return Database.use((db) => listWorkspaceUsageWithDb(db, Actor.workspace(), page, limit))
}

export async function listWorkspaceUsageWithDb(db: Database.TxOrDb, workspaceID: string, page = 0, limit = 50) {
  const workspace = workspaceIdentifier.parse(workspaceID)
  const boundedPage = pageNumber.parse(page)
  const boundedLimit = pageSize.parse(limit)

  return db
    .select()
    .from(UsageTable)
    .where(and(eq(UsageTable.workspaceID, workspace), isNull(UsageTable.timeDeleted)))
    .orderBy(desc(UsageTable.timeCreated), desc(UsageTable.id))
    .limit(boundedLimit)
    .offset(boundedPage * boundedLimit)
}
