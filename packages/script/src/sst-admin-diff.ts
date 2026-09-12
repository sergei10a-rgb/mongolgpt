import { isDeepStrictEqual } from "node:util"

const adminSiteType = "sst:cloudflare:SolidStart"
const accessApplicationType = "cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication"
const accessApplicationUrn = `urn:pulumi:dev::mongolgpt-admin::${accessApplicationType}::AdminAccessApplication`

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
  ["default", /^pulumi:providers:pulumi-nodejs$/],
  ["default_1_0_1", /^pulumi:providers:command$/],
  ["default_6_15_0", /^pulumi:providers:cloudflare$/],
])

const allowedOperations = new Set(["create", "update"])
const adminBuilderReplacementOperations = new Set(["create-replacement", "replace", "delete-replaced"])
const createOnlyResources = new Set(["AdminAccessApplication", "AdminAccessConfig", "AdminAccessProvider", "default"])
const createOnlyLinkRefs = new Set([
  "AdminAccessConfigLinkRef",
  "AdminLinkRef",
  "AdminPaymentCancellationTokenLinkRef",
  "AdminPaymentRefundTokenLinkRef",
  "AuthApiLinkRef",
  "D1BackupsLinkRef",
  "DatabaseLinkRef",
  "MONGOLGPT_PLAN_LIMITSLinkRef",
  "MongolGPTAdminBootstrapEmailsLinkRef",
  "PaymentServiceLinkRef",
  "QuotaServiceLinkRef",
  "QuotaServiceTokenLinkRef",
  "ServiceMonitorStateLinkRef",
  "UsageQueueReadinessLinkRef",
])
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

export function inspectAdminDeploymentDiff(
  value: unknown,
  options: { allowAccessCookieMigration?: boolean } = {},
): AdminDeploymentDiffSummary {
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
    if (
      !isAllowedAdminOperation(parsed.type, parsed.name, type, op) ||
      !isAllowedAdminChange(
        parsed.type,
        parsed.name,
        type,
        op,
        entry?.detailedDiff,
        options.allowAccessCookieMigration === true && accessCookieMigrationError(entry) === undefined,
      )
    ) {
      if (rejected.length < 12) {
        rejected.push(`${op} ${type} ${parsed.name}`)
        if (options.allowAccessCookieMigration && parsed.name === "AdminAccessApplication") {
          const diff = record(entry?.detailedDiff)
          const fields = Object.entries(diff ?? {})
            .slice(0, 12)
            .map(([key, value]) => {
              const field = /^[a-zA-Z0-9_.\[\]]{1,100}$/.test(key) ? key : "redacted-path"
              const kind = record(value)?.diffKind
              return `${field}:${["add", "delete", "update", "add-replace", "delete-replace", "update-replace"].includes(String(kind)) ? kind : "unknown"}`
            })
          rejected.push(`Access cookie diff fields=${fields.join(",") || "missing"}`)
          rejected.push(`Access cookie proof=${accessCookieMigrationError(entry) ?? "valid"}`)
        }
      }
      continue
    }
    operations[op] = (operations[op] ?? 0) + 1
  }

  if (rejected.length) {
    throw new AdminDeploymentDiffError(`Admin bootstrap diff зөвшөөрөөгүй өөрчлөлт илрүүллээ: ${rejected.join("; ")}`)
  }

  return { changes: value.length, operations }
}

function isAllowedAdminOperation(urnType: string, name: string, type: string, op: string) {
  if (allowedOperations.has(op)) return true
  return (
    name === "AdminBuilder" &&
    type === "command:local:Command" &&
    urnType.split("$").includes(adminSiteType) &&
    urnType.split("$").at(-1) === type &&
    adminBuilderReplacementOperations.has(op)
  )
}

function isAllowedAdminChange(
  urnType: string,
  name: string,
  type: string,
  op: string,
  detailedDiff: unknown,
  allowAccessCookieMigration: boolean,
) {
  if (type === "pulumi:pulumi:Stack") {
    if (name !== "mongolgpt-admin-dev") return false
    return op === "create" || (op === "update" && isAdminStackOutputDiff(detailedDiff))
  }

  if (type === "sst:sst:LinkRef") return op === "create" && createOnlyLinkRefs.has(name)

  if (name === "AdminAccessApplication" && op === "update") {
    return allowAccessCookieMigration && type === accessApplicationType
  }

  const exact = exactResources.get(name)
  if (exact) return exact.test(type) && (!createOnlyResources.has(name) || op === "create")

  if (!name.startsWith("Admin") || !urnType.split("$").includes(adminSiteType)) return false
  return type === urnType.split("$").at(-1)
}

function accessCookieMigrationError(entry: Record<string, unknown> | undefined) {
  if (entry?.urn !== accessApplicationUrn || entry.type !== accessApplicationType || entry.op !== "update") {
    return "resource-mismatch"
  }
  if (entry.keys != null && (!Array.isArray(entry.keys) || entry.keys.length !== 0)) return "replacement-keys"
  if (entry.diffs != null && !isDeepStrictEqual(entry.diffs, ["sameSiteCookieAttribute"])) return "unexpected-diffs"

  // Pulumi output events may omit detailedDiff. Prove the exact input transition in either case.
  if (entry.detailedDiff != null) {
    const diff = record(entry.detailedDiff)
    if (!diff || Object.keys(diff).length !== 1 || record(diff.sameSiteCookieAttribute)?.diffKind !== "update")
      return "unexpected-detailed-diff"
  }
  const old = record(entry.old)
  const next = record(entry.new)
  if (
    !old ||
    !next ||
    old.urn !== accessApplicationUrn ||
    next.urn !== accessApplicationUrn ||
    old.type !== accessApplicationType ||
    next.type !== accessApplicationType ||
    !text(old.id) ||
    !text(old.provider) ||
    entry.provider !== old.provider
  )
    return "missing-resource-state"

  const metadata = (state: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(state).filter(([key]) => key !== "inputs" && key !== "outputs"))
  if (!isDeepStrictEqual(metadata(old), metadata(next))) return "changed-resource-state"

  const before = record(old.inputs)
  const after = record(next.inputs)
  if (!before || !after) return "missing-inputs"
  if (hasOpaqueValue(before) || hasOpaqueValue(after)) return "opaque-inputs"
  if (before.sameSiteCookieAttribute !== "strict" || after.sameSiteCookieAttribute !== "lax")
    return "wrong-cookie-transition"
  if (!isDeepStrictEqual({ ...before, sameSiteCookieAttribute: "lax" }, after)) return "other-input-changes"
}

function hasOpaqueValue(value: unknown): boolean {
  if (typeof value === "string") return value.includes("[secret]") || value === "04da6b54-80e4-46f7-96ec-b56ff0331ba9"
  if (Array.isArray(value)) return value.some(hasOpaqueValue)
  if (typeof value !== "object" || value === null) return false
  if (Object.hasOwn(value, "4dabf18193072939515e22adb298388d")) return true
  return Object.values(value).some(hasOpaqueValue)
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
  return Object.fromEntries(Object.entries(value))
}
