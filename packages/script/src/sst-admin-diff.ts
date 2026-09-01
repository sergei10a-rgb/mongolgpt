const adminSiteType = "sst:cloudflare:SolidStart"

const exactResources = new Map<string, RegExp>([
  ["AdminAccessApplication", /zeroTrustAccessApplication/i],
  ["AdminAccessConfig", /^sst:sst:Linkable$/],
  ["AdminAccessOrganizationMfa", /^command:local:Command$/],
  ["AdminAccessProvider", /^pulumi:providers:cloudflare$/],
  ["AdminPaymentCancellationToken", /^sst:sst:Linkable$/],
  ["AdminPaymentRefundToken", /^sst:sst:Linkable$/],
  ["AuthApi", /^sst:sst:Linkable$/],
  ["D1Backups", /^sst:sst:Linkable$/],
  ["Database", /^sst:sst:Linkable$/],
  ["MONGOLGPT_PLAN_LIMITS", /^sst:sst:Secret$/],
  ["MongolGPTAdminBootstrapEmails", /^sst:sst:Secret$/],
  ["PaymentService", /^sst:sst:Linkable$/],
  ["QuotaService", /^sst:sst:Linkable$/],
  ["QuotaServiceToken", /^sst:sst:Linkable$/],
  ["ServiceMonitorState", /^sst:sst:Linkable$/],
  ["UsageQueueReadiness", /^sst:sst:Linkable$/],
  ["default_1_0_1", /^pulumi:providers:command$/],
  ["default_6_15_0", /^pulumi:providers:cloudflare$/],
])

const allowedOperations = new Set(["create", "update"])
const createOnlyResources = new Set(["AdminAccessApplication", "AdminAccessConfig", "AdminAccessProvider"])
const maximumChanges = 2_000

export class AdminDeploymentDiffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AdminDeploymentDiffError"
  }
}

export interface AdminDeploymentDiffSummary {
  changes: number
  operations: Record<string, number>
}

export function inspectAdminDeploymentDiff(value: unknown): AdminDeploymentDiffSummary {
  if (!Array.isArray(value)) {
    throw new AdminDeploymentDiffError("SST admin diff нь JSON жагсаалт биш байна.")
  }
  if (value.length > maximumChanges) {
    throw new AdminDeploymentDiffError(`SST admin diff хэт олон өөрчлөлттэй байна: ${value.length}.`)
  }

  const operations: Record<string, number> = {}
  const rejected: string[] = []
  for (const [index, raw] of value.entries()) {
    const entry = record(raw)
    const urn = text(entry?.urn)
    const type = text(entry?.type)
    const op = text(entry?.op)
    if (!urn || !type || !op) {
      throw new AdminDeploymentDiffError(`SST admin diff-ийн ${index + 1}-р мөрийн urn, type эсвэл op дутуу байна.`)
    }

    const parsed = parseUrn(urn)
    if (!allowedOperations.has(op) || !isAllowedAdminChange(parsed.type, parsed.name, type, op, entry?.detailedDiff)) {
      if (rejected.length < 12) rejected.push(`${op} ${type} ${parsed.name}`)
      continue
    }
    operations[op] = (operations[op] ?? 0) + 1
  }

  if (rejected.length) {
    throw new AdminDeploymentDiffError(`Admin bootstrap diff зөвшөөрөөгүй өөрчлөлт илрүүллээ: ${rejected.join("; ")}`)
  }

  return { changes: value.length, operations }
}

function isAllowedAdminChange(urnType: string, name: string, type: string, op: string, detailedDiff: unknown) {
  if (type === "pulumi:pulumi:Stack") {
    return op === "update" && isAdminStackOutputDiff(detailedDiff)
  }

  const exact = exactResources.get(name)
  if (exact) return exact.test(type) && (!createOnlyResources.has(name) || op === "create")

  if (!name.startsWith("Admin") || !urnType.split("$").includes(adminSiteType)) return false
  return type === urnType.split("$").at(-1)
}

function isAdminStackOutputDiff(value: unknown) {
  const diff = record(value)
  if (!diff) return false
  const keys = Object.keys(diff)
  if (!keys.length) return false
  return keys.every((key) => /^(?:outputs\.)?(?:AdminUrl|HostedServices)(?:\.|$)/.test(key))
}

function parseUrn(value: string) {
  const parts = value.split("::")
  const type = parts.at(-2)
  const name = parts.at(-1)
  if (!value.startsWith("urn:pulumi:") || !type || !name) {
    throw new AdminDeploymentDiffError("SST admin diff дотор хүчинтэй Pulumi URN алга байна.")
  }
  return { type, name }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) result[key] = item
  return result
}
