import { planQuotaScope, QuotaLedgerRequestSchema } from "@mongolgpt/console-core/quota.js"
import { Resource } from "@mongolgpt/console-resource"

export async function deactivatePlanQuota(workspaceID: string, invoiceID: string) {
  const request = QuotaLedgerRequestSchema.parse({
    scope: `${Resource.App.stage}:${planQuotaScope(workspaceID, invoiceID)}`,
    command: { type: "deactivate" },
  })
  const response = await Resource.QuotaService.fetch("https://quota.internal/v1/ledger", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Resource.QuotaServiceToken.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  })
  const payload = (await response.json().catch(() => ({}))) as { deactivated?: unknown }
  if (!response.ok || payload.deactivated !== true) {
    throw new Error("Plan quota scope-ийг хааж чадсангүй")
  }
}
