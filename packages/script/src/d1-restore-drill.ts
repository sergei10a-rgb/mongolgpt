import {
  D1_BACKUP_MANIFEST_MAX_BYTES,
  D1_BACKUP_MAX_BYTES,
  parseD1BackupManifest,
  type D1BackupManifest,
} from "@mongolgpt/console-core/d1-backup-manifest.js"

const API_ROOT = "https://api.cloudflare.com/client/v4"
const MAX_API_RESPONSE_BYTES = 1024 * 1024
const MAX_LIST_PAGES = 10
const MAX_BACKUP_AGE_MS = 36 * 60 * 60 * 1_000
const FUTURE_CLOCK_SKEW_MS = 2 * 60 * 1_000
const REQUIRED_TABLES = ["account", "admin_audit_log", "payment_invoice", "plan_subscription", "usage", "user", "workspace"] as const

export type D1RestoreDrillConfig = {
  accountId: string
  sourceDatabaseId: string
  backupBucket: string
  apiToken: string
  stage: "dev"
  runId: string
}

export type MaterializedD1Backup = {
  size: number
  md5: string
  body(): BodyInit
  cleanup(): Promise<void>
}

export type D1RestoreDrillReceipt = {
  version: 1
  kind: "mongolgpt-d1-restore-drill"
  stage: "dev"
  backupKey: string
  backupCreatedAt: string
  drillDatabaseName: string
  verifiedTables: string[]
  completedAt: string
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type DrillOptions = {
  fetcher?: Fetcher
  now?: () => Date
  materialize(response: Response, manifest: D1BackupManifest): Promise<MaterializedD1Backup>
  restore(input: {
    accountId: string
    databaseId: string
    databaseName: string
    artifact: MaterializedD1Backup
    apiToken: string
  }): Promise<void>
}

type R2Object = {
  key: string
  size: number
  etag: string
}

export async function executeD1RestoreDrill(config: D1RestoreDrillConfig, options: DrillOptions) {
  validateConfig(config)
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? (() => new Date())
  const manifest = await readLatestBackupManifest(config, fetcher, now())
  const backup = await downloadBackup(config, manifest, fetcher)
  const artifact = await options.materialize(backup, manifest)
  let databaseId: string | undefined
  let receipt: D1RestoreDrillReceipt | undefined
  let primaryError: unknown
  try {
    validateMaterializedBackup(artifact, manifest)
    const databaseName = `mongolgpt-restore-drill-${config.runId}`
    const createdDatabaseId = await createDrillDatabase(config, databaseName, fetcher)
    if (createdDatabaseId.toLowerCase() === config.sourceDatabaseId.toLowerCase()) {
      throw new Error("Сэргээх туршилтын D1 нь эх өгөгдлийн сантай ижил байж болохгүй.")
    }
    databaseId = createdDatabaseId
    await options.restore({
      accountId: config.accountId,
      databaseId,
      databaseName,
      artifact,
      apiToken: config.apiToken,
    })
    const verifiedTables = await verifyDrillDatabase(config, databaseId, fetcher)
    receipt = {
      version: 1,
      kind: "mongolgpt-d1-restore-drill",
      stage: "dev",
      backupKey: manifest.artifact.key,
      backupCreatedAt: manifest.createdAt,
      drillDatabaseName: databaseName,
      verifiedTables,
      completedAt: now().toISOString(),
    }
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors: unknown[] = []
    if (databaseId) {
      try {
        await deleteDrillDatabase(config, databaseId, fetcher)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await artifact.cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
    throwCombinedD1RestoreDrillErrors(primaryError, cleanupErrors)
  }
  if (!receipt) throw new Error("D1 restore drill үр дүнгүй дууслаа.")
  return receipt
}

export function buildD1RestoreDrillChildEnvironment(
  source: Record<string, string | undefined>,
  input: { accountId: string; apiToken: string },
) {
  const result: Record<string, string> = {
    CI: "true",
    CLOUDFLARE_ACCOUNT_ID: input.accountId,
    CLOUDFLARE_API_TOKEN: input.apiToken,
  }
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TEMP",
    "TMP",
    "BUN_INSTALL",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
  ]) {
    const value = source[name]
    if (value) result[name] = value
  }
  return result
}

function throwCombinedD1RestoreDrillErrors(primaryError: unknown, cleanupErrors: unknown[]) {
  if (primaryError !== undefined) {
    if (!cleanupErrors.length) throw primaryError
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `D1 restore drill амжилтгүй болсон (${errorMessage(primaryError)}), мөн цэвэрлэгээний ${cleanupErrors.length} алдаа гарлаа.`,
      { cause: primaryError },
    )
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, `D1 restore drill-ийн цэвэрлэгээнд ${cleanupErrors.length} алдаа гарлаа.`)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "тодорхойгүй алдаа"
}

async function readLatestBackupManifest(config: D1RestoreDrillConfig, fetcher: Fetcher, now: Date) {
  const objects = await listBackupObjects(config, fetcher)
  const prefix = `d1/${config.stage}/`
  const latest = objects
    .filter((item) => item.key.startsWith(prefix) && item.key.endsWith(".sql.manifest.json"))
    .sort((a, b) => b.key.localeCompare(a.key))[0]
  if (!latest) throw new Error("Сэргээх туршилтад ашиглах D1 backup manifest олдсонгүй.")
  if (latest.size <= 0 || latest.size > D1_BACKUP_MANIFEST_MAX_BYTES) {
    throw new Error("D1 backup manifest-ийн хэмжээ буруу байна.")
  }

  const response = await cloudflareFetch(config, r2ObjectPath(config, latest.key), { method: "GET" }, fetcher)
  const body = await readBoundedText(response, D1_BACKUP_MANIFEST_MAX_BYTES, "D1 backup manifest")
  const manifest = parseD1BackupManifest(body, { stage: config.stage, databaseId: config.sourceDatabaseId })
  const age = now.getTime() - new Date(manifest.createdAt).getTime()
  if (age < -FUTURE_CLOCK_SKEW_MS || age > MAX_BACKUP_AGE_MS) {
    throw new Error("Сэргээх туршилтын D1 backup 36 цагаас хуучин эсвэл ирээдүйн хугацаатай байна.")
  }
  return manifest
}

async function listBackupObjects(config: D1RestoreDrillConfig, fetcher: Fetcher) {
  const objects: R2Object[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ size: "1000" })
    if (cursor) query.set("cursor", cursor)
    const envelope = await cloudflareJson(
      config,
      `/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(config.backupBucket)}/objects?${query}`,
      { method: "GET" },
      fetcher,
    )
    if (!Array.isArray(envelope.result)) throw new Error("Cloudflare R2 object жагсаалтын бүтэц буруу байна.")
    objects.push(...envelope.result.map(parseR2Object))
    const info = record(envelope.result_info) ? envelope.result_info : undefined
    if (info?.is_truncated !== true) return objects
    cursor = boundedString(info.cursor, 2048)
    if (!cursor) throw new Error("Cloudflare R2 object жагсаалтын cursor дутуу байна.")
  }
  throw new Error("Cloudflare R2 object жагсаалт зөвшөөрөгдсөн хуудасны хязгаараас хэтэрлээ.")
}

async function downloadBackup(config: D1RestoreDrillConfig, manifest: D1BackupManifest, fetcher: Fetcher) {
  const response = await cloudflareFetch(config, r2ObjectPath(config, manifest.artifact.key), { method: "GET" }, fetcher)
  if (!response.body) throw new Error("D1 backup SQL хоосон байна.")
  const length = response.headers.get("content-length")
  if (length && Number(length) !== manifest.artifact.size) throw new Error("D1 backup SQL хэмжээ manifest-тай зөрж байна.")
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType && contentType !== manifest.artifact.contentType) {
    throw new Error("D1 backup SQL content type manifest-тай зөрж байна.")
  }
  const etag = response.headers.get("etag")?.trim().replace(/^W\//, "").replace(/^"|"$/g, "")
  if (etag && etag !== manifest.artifact.etag.replace(/^"|"$/g, "")) {
    throw new Error("D1 backup SQL ETag manifest-тай зөрж байна.")
  }
  return response
}

async function createDrillDatabase(config: D1RestoreDrillConfig, name: string, fetcher: Fetcher) {
  const envelope = await cloudflareJson(
    config,
    `/accounts/${config.accountId}/d1/database`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, primary_location_hint: "apac", read_replication: { mode: "disabled" } }),
    },
    fetcher,
  )
  if (!record(envelope.result)) throw new Error("Cloudflare D1 create хариуны бүтэц буруу байна.")
  const databaseId = boundedString(envelope.result.uuid, 64)
  if (!databaseId || !databaseIdPattern(databaseId)) throw new Error("Сэргээх туршилтын D1 ID буруу байна.")
  return databaseId
}

async function verifyDrillDatabase(config: D1RestoreDrillConfig, databaseId: string, fetcher: Fetcher) {
  const names = REQUIRED_TABLES.map((name) => `'${name}'`).join(",")
  const envelope = await cloudflareJson(
    config,
    `/accounts/${config.accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${names}) ORDER BY name`,
        params: [],
      }),
    },
    fetcher,
  )
  const result = Array.isArray(envelope.result) ? envelope.result[0] : envelope.result
  if (!record(result) || result.success !== true || !Array.isArray(result.results)) {
    throw new Error("Сэргээсэн D1 schema шалгалтын бүтэц буруу байна.")
  }
  const verified = result.results.map((row) => (record(row) ? boundedString(row.name, 128) : undefined)).filter(Boolean)
  if (verified.length !== REQUIRED_TABLES.length || REQUIRED_TABLES.some((name) => !verified.includes(name))) {
    throw new Error("Сэргээсэн D1-д зайлшгүй хүснэгтүүд дутуу байна.")
  }
  return [...REQUIRED_TABLES]
}

async function deleteDrillDatabase(config: D1RestoreDrillConfig, databaseId: string, fetcher: Fetcher) {
  await cloudflareJson(
    config,
    `/accounts/${config.accountId}/d1/database/${databaseId}`,
    { method: "DELETE" },
    fetcher,
  )
}

function validateMaterializedBackup(artifact: MaterializedD1Backup, manifest: D1BackupManifest) {
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > D1_BACKUP_MAX_BYTES) {
    throw new Error("Татсан D1 backup SQL хэмжээ буруу байна.")
  }
  if (artifact.size !== manifest.artifact.size) throw new Error("Татсан D1 backup SQL хэмжээ manifest-тай зөрж байна.")
  if (!/^[a-f0-9]{32}$/.test(artifact.md5)) throw new Error("Татсан D1 backup SQL MD5 буруу байна.")
}

async function cloudflareJson(
  config: D1RestoreDrillConfig,
  path: string,
  init: RequestInit,
  fetcher: Fetcher,
) {
  const response = await cloudflareFetch(config, path, init, fetcher)
  const body = await readBoundedText(response, MAX_API_RESPONSE_BYTES, "Cloudflare API")
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new Error("Cloudflare API зөв JSON буцаасангүй.")
  }
  if (!record(value)) throw new Error("Cloudflare API-ийн хариу объект биш байна.")
  if (value.success !== true) throw new Error(apiError(value))
  return value
}

async function cloudflareFetch(
  config: D1RestoreDrillConfig,
  path: string,
  init: RequestInit,
  fetcher: Fetcher,
) {
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${config.apiToken}`)
  const response = await fetcher(`${API_ROOT}${path}`, {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Cloudflare API HTTP ${response.status} буцаалаа.`)
  return response
}

async function readBoundedText(response: Response, limit: number, label: string) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) throw new Error(`${label} хариу хэт том байна.`)
  const body = await response.text()
  if (new TextEncoder().encode(body).byteLength > limit) throw new Error(`${label} хариу хэт том байна.`)
  return body
}

function r2ObjectPath(config: D1RestoreDrillConfig, key: string) {
  const objectKey = key.split("/").map(encodeURIComponent).join("/")
  return `/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(config.backupBucket)}/objects/${objectKey}`
}

function parseR2Object(value: unknown): R2Object {
  if (!record(value)) throw new Error("Cloudflare R2 object-ийн бүтэц буруу байна.")
  const key = boundedString(value.key, 1024)
  const etag = boundedString(value.etag, 1024)
  if (!key || !etag || !Number.isSafeInteger(value.size) || Number(value.size) <= 0) {
    throw new Error("Cloudflare R2 object-ийн бүтэц буруу байна.")
  }
  return { key, etag, size: Number(value.size) }
}

function validateConfig(config: D1RestoreDrillConfig) {
  if (config.stage !== "dev") throw new TypeError("Автомат D1 сэргээх туршилт зөвхөн dev орчинд ажиллана.")
  if (!/^[a-f0-9]{32}$/i.test(config.accountId)) throw new TypeError("Cloudflare account ID буруу байна.")
  if (!databaseIdPattern(config.sourceDatabaseId)) throw new TypeError("Эх D1 database ID буруу байна.")
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(config.backupBucket)) throw new TypeError("R2 backup bucket буруу байна.")
  if (!/^[0-9]{1,24}$/.test(config.runId)) throw new TypeError("Restore drill run ID буруу байна.")
  if (!config.apiToken.trim() || config.apiToken.length > 512) throw new TypeError("Cloudflare restore drill token буруу байна.")
}

function databaseIdPattern(value: string) {
  return /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, max: number) {
  if (typeof value !== "string") return undefined
  const result = value.trim()
  if (!result || result.length > max || /[\r\n\t]/.test(result)) return undefined
  return result
}

function apiError(value: Record<string, unknown>) {
  const errors = Array.isArray(value.errors) ? value.errors : []
  const messages = errors
    .slice(0, 3)
    .map((error) => {
      if (!record(error)) return undefined
      const code = typeof error.code === "number" ? error.code : "unknown"
      const message = boundedString(error.message, 256)?.replace(/[\r\n\t]/g, " ")
      return message ? `${code}: ${message}` : undefined
    })
    .filter(Boolean)
  return messages.length ? `Cloudflare API алдаа: ${messages.join("; ")}` : "Cloudflare API хүсэлт амжилтгүй боллоо."
}
