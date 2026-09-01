const MAX_STATE_BYTES = 32 * 1024 * 1024
const PULUMI_SPECIAL_SIGNATURE = "4dabf18193072939515e22adb298388d"
const PULUMI_SECRET_SIGNATURE = ["1b470612", "64138c4a", "c30d75fd", "1eb44270"].join("")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KV_NAMESPACE_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
const R2_BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/

type JsonRecord = Record<string, unknown>
type Resource = JsonRecord & {
  id?: unknown
  type?: unknown
  urn?: unknown
  outputs?: unknown
}

type ExtractedResource<T extends string> = {
  type: T
  name: string
  outputKey: string
  kind: "uuid" | "bucket" | "kv" | "url" | "secret"
}

const expectedResources = [
  { type: "sst:cloudflare:D1", name: "Database", outputKey: "databaseId", kind: "uuid" },
  { type: "sst:cloudflare:Bucket", name: "D1Backups", outputKey: "name", kind: "bucket" },
  { type: "sst:cloudflare:Kv", name: "UsageQueueReadiness", outputKey: "namespaceId", kind: "kv" },
  { type: "sst:cloudflare:Kv", name: "ServiceMonitorState", outputKey: "namespaceId", kind: "kv" },
  { type: "sst:cloudflare:Worker", name: "AuthApi", outputKey: "url", kind: "url" },
  { type: "sst:cloudflare:Worker", name: "QuotaService", outputKey: "url", kind: "url" },
  { type: "sst:cloudflare:Worker", name: "PaymentService", outputKey: "url", kind: "url" },
  {
    type: "random:index/randomPassword:RandomPassword",
    name: "QuotaServiceToken",
    outputKey: "result",
    kind: "secret",
  },
  {
    type: "random:index/randomPassword:RandomPassword",
    name: "AdminPaymentCancellationToken",
    outputKey: "result",
    kind: "secret",
  },
  {
    type: "random:index/randomPassword:RandomPassword",
    name: "AdminPaymentRefundToken",
    outputKey: "result",
    kind: "secret",
  },
] as const satisfies readonly ExtractedResource<string>[]

export type SstAdminExternalState = Readonly<{
  databaseId: string
  d1BackupsBucket: string
  usageQueueReadinessKvId: string
  serviceMonitorStateKvId: string
  authApiUrl: string
  quotaServiceUrl: string
  paymentServiceUrl: string
  quotaServiceToken: string
  paymentCancellationToken: string
  paymentRefundToken: string
}>

export class SstAdminExternalStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SstAdminExternalStateError"
  }
}

export function extractSstAdminExternalState(input: unknown): SstAdminExternalState {
  const resources = checkpointResources(input)
  const databaseId = readExpectedValue(resources, expectedResources[0])
  const d1BackupsBucket = readExpectedValue(resources, expectedResources[1])
  const usageQueueReadinessKvId = readExpectedValue(resources, expectedResources[2])
  const serviceMonitorStateKvId = readExpectedValue(resources, expectedResources[3])
  const authApiUrl = readExpectedValue(resources, expectedResources[4])
  const quotaServiceUrl = readExpectedValue(resources, expectedResources[5])
  const paymentServiceUrl = readExpectedValue(resources, expectedResources[6])
  const quotaServiceToken = readExpectedValue(resources, expectedResources[7])
  const paymentCancellationToken = readExpectedValue(resources, expectedResources[8])
  const paymentRefundToken = readExpectedValue(resources, expectedResources[9])

  return {
    databaseId,
    d1BackupsBucket,
    usageQueueReadinessKvId,
    serviceMonitorStateKvId,
    authApiUrl,
    quotaServiceUrl,
    paymentServiceUrl,
    quotaServiceToken,
    paymentCancellationToken,
    paymentRefundToken,
  }
}

export async function readSstAdminExternalStateFile(path: string) {
  const trimmedPath = path.trim()
  if (!trimmedPath) throw new SstAdminExternalStateError("SST state file path дутуу байна.")

  let stats: { size: number; isFile(): boolean }
  try {
    stats = await Bun.file(trimmedPath).stat()
  } catch {
    throw new SstAdminExternalStateError("SST state file олдсонгүй эсвэл уншиж чадсангүй.")
  }
  if (!stats.isFile()) throw new SstAdminExternalStateError("SST state file олдсонгүй эсвэл уншиж чадсангүй.")
  if (stats.size > MAX_STATE_BYTES) {
    throw new SstAdminExternalStateError("SST state file 32 MiB хязгаараас их байна.")
  }

  let text: string
  try {
    text = await Bun.file(trimmedPath).text()
  } catch {
    throw new SstAdminExternalStateError("SST state file уншиж чадсангүй.")
  }
  if (!text.trim()) throw new SstAdminExternalStateError("SST state file хоосон байна.")

  let state: unknown
  try {
    state = JSON.parse(text)
  } catch {
    throw new SstAdminExternalStateError("SST state JSON хүчинтэй биш байна.")
  }

  return extractSstAdminExternalState(state)
}

export function formatSstAdminExternalStateEnv(state: SstAdminExternalState) {
  const entries = [
    ["MONGOLGPT_ADMIN_DATABASE_ID", state.databaseId],
    ["MONGOLGPT_ADMIN_D1_BACKUPS_BUCKET", state.d1BackupsBucket],
    ["MONGOLGPT_ADMIN_USAGE_QUEUE_READINESS_KV_ID", state.usageQueueReadinessKvId],
    ["MONGOLGPT_ADMIN_SERVICE_MONITOR_STATE_KV_ID", state.serviceMonitorStateKvId],
    ["MONGOLGPT_ADMIN_AUTH_API_URL", state.authApiUrl],
    ["MONGOLGPT_ADMIN_QUOTA_SERVICE_URL", state.quotaServiceUrl],
    ["MONGOLGPT_ADMIN_PAYMENT_SERVICE_URL", state.paymentServiceUrl],
    ["MONGOLGPT_ADMIN_QUOTA_SERVICE_TOKEN", state.quotaServiceToken],
    ["MONGOLGPT_ADMIN_PAYMENT_CANCELLATION_TOKEN", state.paymentCancellationToken],
    ["MONGOLGPT_ADMIN_PAYMENT_REFUND_TOKEN", state.paymentRefundToken],
  ] as const

  return entries.map(([name, value]) => `${name}=${validateEnvValue(name, value)}`)
}

function readExpectedValue(resources: readonly unknown[], expected: ExtractedResource<string>) {
  const matches = resources.filter((resource): resource is Resource => isResource(resource, expected))
  if (matches.length !== 1) {
    throw new SstAdminExternalStateError(
      `SST state дотор ${expected.type} ${expected.name} яг нэг байх ёстой, ${matches.length} олдлоо.`,
    )
  }

  const outputs = record(matches[0].outputs) ? matches[0].outputs : undefined
  const raw =
    outputs && expected.outputKey in outputs ? outputs[expected.outputKey] : fallbackResourceValue(resources, expected)
  switch (expected.kind) {
    case "uuid":
      return readUuid(raw, expected)
    case "bucket":
      return readBucketName(raw, expected)
    case "kv":
      return readKvNamespaceId(raw, expected)
    case "url":
      return readHttpsUrl(raw, expected)
    case "secret":
      return readSecretValue(raw, expected)
  }
}

function fallbackResourceValue(resources: readonly unknown[], expected: ExtractedResource<string>) {
  switch (expected.name) {
    case "Database": {
      const resource = exactResource(resources, "cloudflare:index/d1Database:D1Database", "DatabaseDatabase")
      const outputs = resourceOutputs(resource)
      return outputs.uuid ?? providerId(resource, expected.name)
    }
    case "D1Backups": {
      const resource = exactResource(resources, "cloudflare:index/r2Bucket:R2Bucket", "D1BackupsBucket")
      const outputs = resourceOutputs(resource)
      return outputs.name ?? providerId(resource, expected.name)
    }
    case "UsageQueueReadiness":
    case "ServiceMonitorState": {
      const resource = exactResource(
        resources,
        "cloudflare:index/workersKvNamespace:WorkersKvNamespace",
        `${expected.name}Namespace`,
      )
      const outputs = resourceOutputs(resource)
      return outputs.id ?? providerId(resource, expected.name)
    }
    case "AuthApi":
    case "PaymentService": {
      const resource = exactResource(
        resources,
        "cloudflare:index/workersCustomDomain:WorkersCustomDomain",
        `${expected.name}Domain`,
      )
      const hostname = readSafeScalar(resourceOutputs(resource).hostname, expected)
      return `https://${hostname}`
    }
    case "QuotaService": {
      const resource = exactResource(
        resources,
        "pulumi-nodejs:dynamic:Resource",
        "QuotaServiceUrl.sst.cloudflare.WorkerUrl",
      )
      const raw = readSafeScalar(resourceOutputs(resource).url, expected)
      return raw.includes("://") ? raw : `https://${raw}`
    }
    default:
      throw new SstAdminExternalStateError(
        `SST state дотор ${expected.type} ${expected.name} ${expected.outputKey} output дутуу байна.`,
      )
  }
}

function exactResource(resources: readonly unknown[], type: string, name: string) {
  const matches = resources.filter(
    (resource): resource is Resource =>
      record(resource) &&
      resource.type === type &&
      typeof resource.urn === "string" &&
      resourceName(resource.urn) === name,
  )
  if (matches.length !== 1) {
    throw new SstAdminExternalStateError(`SST state дотор ${type} ${name} яг нэг байх ёстой, ${matches.length} олдлоо.`)
  }
  return matches[0]
}

function resourceOutputs(resource: Resource) {
  return record(resource.outputs) ? resource.outputs : {}
}

function providerId(resource: Resource, name: string) {
  if (typeof resource.id !== "string") {
    throw new SstAdminExternalStateError(`SST state дотор ${name} provider ID дутуу байна.`)
  }
  const value = resource.id.split("/").at(-1)
  if (!value) throw new SstAdminExternalStateError(`SST state дотор ${name} provider ID дутуу байна.`)
  return value
}

function isResource(resource: unknown, expected: ExtractedResource<string>) {
  if (!record(resource)) return false
  if (resource.type !== expected.type) return false
  if (typeof resource.urn !== "string") return false
  return resourceName(resource.urn) === expected.name
}

function checkpointResources(input: unknown) {
  if (!record(input)) throw new SstAdminExternalStateError("SST state объект биш байна.")

  if ("checkpoint" in input) {
    const checkpoint = record(input.checkpoint) ? input.checkpoint : undefined
    if (!checkpoint) throw new SstAdminExternalStateError("SST state checkpoint дутуу байна.")
    const latest = record(checkpoint.latest) ? checkpoint.latest : undefined
    if (!latest) throw new SstAdminExternalStateError("SST state checkpoint.latest дутуу байна.")
    if (!Array.isArray(latest.resources)) {
      throw new SstAdminExternalStateError("SST state checkpoint.latest.resources жагсаалт дутуу байна.")
    }
    return latest.resources
  }

  if (record(input.latest) && Array.isArray(input.latest.resources)) return input.latest.resources
  if (record(input.deployment) && Array.isArray(input.deployment.resources)) return input.deployment.resources

  throw new SstAdminExternalStateError("SST state resources жагсаалт дутуу байна.")
}

function readUuid(value: unknown, expected: ExtractedResource<string>) {
  const text = readSafeScalar(value, expected)
  if (!UUID.test(text)) {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} UUID буруу байна.`)
  }
  return text.toLowerCase()
}

function readBucketName(value: unknown, expected: ExtractedResource<string>) {
  const text = readSafeScalar(value, expected)
  if (!R2_BUCKET_NAME.test(text)) {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} bucket name буруу байна.`)
  }
  return text
}

function readKvNamespaceId(value: unknown, expected: ExtractedResource<string>) {
  const text = readSafeScalar(value, expected)
  if (!KV_NAMESPACE_ID.test(text)) {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} namespaceId буруу байна.`)
  }
  return text
}

function readHttpsUrl(value: unknown, expected: ExtractedResource<string>) {
  const text = readSafeScalar(value, expected)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} URL хүчинтэй биш байна.`)
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    url.pathname !== "/"
  ) {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} URL HTTPS origin биш байна.`)
  }
  return url.origin
}

function readSafeScalar(value: unknown, expected: ExtractedResource<string>) {
  if (typeof value !== "string") {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} output string биш байна.`)
  }
  if (value !== value.trim()) {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} output-д whitespace байж болохгүй.`)
  }
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value) || /\s/.test(value)) {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} output-д control character байж болохгүй.`)
  }
  if (!value) {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} output хоосон байна.`)
  }
  return value
}

function readSecretValue(value: unknown, expected: ExtractedResource<string>) {
  const text = readSafeScalar(unwrapPulumiSecret(value, expected), expected)
  if (text.length < 32) {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} secret output хэт богино байна.`)
  }
  return text
}

function unwrapPulumiSecret(value: unknown, expected: ExtractedResource<string>) {
  if (!record(value)) return value
  const keys = Object.keys(value).sort()
  if (
    keys.length !== 2 ||
    keys[0] !== PULUMI_SPECIAL_SIGNATURE ||
    keys[1] !== "value" ||
    value[PULUMI_SPECIAL_SIGNATURE] !== PULUMI_SECRET_SIGNATURE
  ) {
    throw new SstAdminExternalStateError(`SST state дотор ${expected.name} secret envelope буруу байна.`)
  }
  return value.value
}

function validateEnvValue(name: string, value: string) {
  if (value !== value.trim()) {
    throw new SstAdminExternalStateError(`${name} утга whitespace-гүй байх ёстой.`)
  }
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value) || /\s/.test(value)) {
    throw new SstAdminExternalStateError(`${name} утга control character-гүй байх ёстой.`)
  }
  return value
}

function resourceName(urn: string) {
  const name = urn.split("::").at(-1)
  if (!name) {
    throw new SstAdminExternalStateError("SST state дотор хүчинтэй Pulumi URN алга байна.")
  }
  return name
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
