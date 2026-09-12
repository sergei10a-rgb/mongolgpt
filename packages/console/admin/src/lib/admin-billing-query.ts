import { query } from "@solidjs/router"
import { getAdminBilling } from "./admin-billing"
import { getPlatformAdminContext } from "./admin-context"
import { adminResponse } from "./admin-response"

export const adminBillingQuery = query(async (input: { period?: string; provider?: string; status?: string }) => {
  "use server"
  return adminResponse(() => getAdminBilling(getPlatformAdminContext(), input))
}, "admin.billing")
