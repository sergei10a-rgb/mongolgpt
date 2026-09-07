import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { EventV2 } from "../event"

export const CloudHistoryTombstoneTable = sqliteTable(
  "cloud_history_tombstone",
  {
    aggregate_id: text().notNull().primaryKey(),
    event_id: text().$type<EventV2.ID>().notNull(),
    seq: integer().notNull(),
  },
  (table) => [uniqueIndex("cloud_history_tombstone_event_id_idx").on(table.event_id)],
)
