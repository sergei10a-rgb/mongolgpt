export { requestAccountDeletion, cancelAccountDeletion, getAccountDeletion } from "../../src/account-deletion"
import { drizzle } from "drizzle-orm/d1"
import type { D1Database } from "@cloudflare/workers-types"
export { sql } from "drizzle-orm"

const schema = await import("../../src/schema-d1")
export function createDatabase(binding: D1Database) {
  return drizzle(binding, { schema })
}
