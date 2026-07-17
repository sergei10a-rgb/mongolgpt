import type { UsageQueueEvent } from "@mongolgpt/console-core/quota.js"
import { enqueueUsageEvent } from "./quota-service"

// D1 дээр нэг мөрийг маш өндөр давтамжаар шинэчилдэг workspace-уудын usage-г
// Cloudflare Queue-р дарааллуулж, UsageTable-ийн ID-аар давхар бичилтээс хамгаална.
export const HOT_WORKSPACES = new Set<string>([
  "wrk_01KJ8PX5CH50Y4YNGNS9ZR8YDC", // invoice
])

export function enqueueBatchedUsage(event: UsageQueueEvent, sender = enqueueUsageEvent) {
  return sender(event)
}
