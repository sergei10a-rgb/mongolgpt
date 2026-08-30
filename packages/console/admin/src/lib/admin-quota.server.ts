import { QuotaLedgerRequestSchema } from "@mongolgpt/console-core/quota.js"
import { Resource } from "@mongolgpt/console-resource"
import { z } from "zod"

const quotaResponse = z.object({
  values: z.record(z.string(), z.number().int().nonnegative()),
})

type AdminQuotaResources = {
  stage: string
  token: string
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export function readAdminPlanQuota(input: { scope: string; keys: readonly string[] }) {
  return readAdminPlanQuotaWithResources(input, {
    stage: Resource.App.stage,
    token: Resource.QuotaServiceToken.value,
    fetcher: (request, init) => Resource.QuotaService.fetch(request, init),
  })
}

export async function readAdminPlanQuotaWithResources(
  input: { scope: string; keys: readonly string[] },
  resources: AdminQuotaResources,
) {
  const request = QuotaLedgerRequestSchema.parse({
    scope: `${resources.stage}:${input.scope}`,
    command: { type: "read", keys: [...input.keys] },
  })
  const response = await resources.fetcher("https://quota.internal/v1/ledger", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resources.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error("Админ квотын хүсэлт амжилтгүй боллоо.")
  return quotaResponse.parse(await response.json()).values
}
