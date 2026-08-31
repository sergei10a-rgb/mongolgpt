import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "./database/schema.sql"
import type { BackgroundJob } from "./background-job"

export const BackgroundJobTable = sqliteTable(
  "background_job",
  {
    namespace: text().notNull(),
    id: text().notNull(),
    type: text().notNull(),
    title: text(),
    status: text().$type<BackgroundJob.Status>().notNull(),
    started_at: integer().notNull(),
    completed_at: integer(),
    output: text(),
    error: text(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    owner_token: text().notNull(),
    generation: integer().notNull(),
    heartbeat_at: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.id] }),
    index("background_job_namespace_status_heartbeat_idx").on(table.namespace, table.status, table.heartbeat_at),
  ],
)
