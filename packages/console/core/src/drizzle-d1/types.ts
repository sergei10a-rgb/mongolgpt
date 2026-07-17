import { integer, text } from "drizzle-orm/sqlite-core"

export const ulid = (name: string) => text(name, { length: 30 })

export const workspaceColumns = {
  get id() {
    return ulid("id").notNull()
  },
  get workspaceID() {
    return ulid("workspace_id").notNull()
  },
}

export const id = () => ulid("id").notNull()

export const utc = (name: string) => integer(name, { mode: "timestamp_ms" })

export const currency = (name: string) => integer(name)

export const timestamps = {
  timeCreated: utc("time_created").notNull().defaultNow(),
  timeUpdated: utc("time_updated")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  timeDeleted: utc("time_deleted"),
}
