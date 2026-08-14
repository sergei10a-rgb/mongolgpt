import { query } from "@solidjs/router"
import { getAdminBilling } from "./admin-billing"
import { getPlatformAdminContext } from "./admin-context"

export const adminBillingQuery = query(async (input: { period?: string; provider?: string; status?: string }) => {
  "use server"
  return getAdminBilling(getPlatformAdminContext(), input)
}, "admin.billing")
