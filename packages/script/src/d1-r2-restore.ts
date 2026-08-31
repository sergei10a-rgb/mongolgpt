import { createHash } from "node:crypto"
import {
  D1_BACKUP_MANIFEST_MAX_BYTES,
  d1BackupManifestKey,
  parseD1BackupManifest,
  type D1BackupManifest,
} from "@mongolgpt/console-core/d1-backup-manifest.js"

const API_ROOT = "https://api.cloudflare.com/client/v4"
const MAX_API_RESPONSE_BYTES = 1024 * 1024
const D1_IMPORT_MAX_BYTES = 5 * 1024 * 1024 * 1024
const R2_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000
const FUTURE_CLOCK_SKEW_MS = 2 * 60 * 1_000
const REQUIRED_TABLES = [
  "account",
  "admin_audit_log",
  "payment_invoice",
  "plan_subscription",
  "usage",
  "user",
  "workspace",
] as const

export type D1R2RestoreStage = "dev" | "production"

export type D1R2RestoreConfig = {
  accountId: string
  sourceDatabaseId: string
  backupBucket: string
  apiToken: string
  stage: D1R2RestoreStage
  operationId: string
}

export type MaterializedD1R2Backup = {
  size: number
  md5: string
  cleanup(): Promise<void>
}

export type D1R2RestorePlan = {
  version: 1
  kind: "mongolgpt-d1-r2-restore-plan"
  stage: D1R2RestoreStage
  backupKeySha256: string
  backupCreatedAt: string
  backupSize: number
  recoveryDatabaseName: string
  confirmation: string
}

export type D1R2RestoreReceipt = {
  version: 1
  kind: "mongolgpt-d1-r2-restore"
  stage: D1R2RestoreStage
  backupKeySha256: string
  backupCreatedAt: string
  backupSize: number
  recoveryDatabaseName: string
  verifiedTables: string[]
  integrityCheck: "ok"
  completedAt: string
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type RestoreOptions = {
  fetcher?: Fetcher
  now?: () => Date
  prepared?(plan: D1R2RestorePlan): Promise<void>
  materialize(response: Response, manifest: D1BackupManifest): Promise<MaterializedD1R2Backup>
  restore(input: {
    accountId: string
    databaseId: string
    databaseName: string
    artifact: MaterializedD1R2Backup
    apiToken: string
  }): Promise<void>
}

type R2Object = {
  key: string
  size: number
  etag: string
  contentType: string
  customMetadata: Record<string, string>
}

type BackupEvidence = {
  manifest: D1BackupManifest
  artifact: R2Object
}

export function d1R2RecoveryDatabaseName(stage: D1R2RestoreStage, operationId: string) {
  if (stage !== "dev" && stage !== "production") throw new TypeError("D1 R2 сэргээх орчин буруу байна.")
  if (!/^[0-9]{1,24}(?:-[0-9]{1,8})?$/.test(operationId)) throw new TypeError("D1 R2 сэргээх operation ID буруу байна.")
  const name = `mongolgpt-r2-recovery-${stage}-${operationId}`
  if (name.length > 64) throw new TypeError("D1 recovery өгөгдлийн сангийн нэр хэт урт байна.")
  return name
}

export function d1R2RestoreConfirmation(stage: D1R2RestoreStage, backupKey: string) {
  return `RESTORE R2 D1 ${stage} ${backupKey}`
}

export async function planD1R2Restore(
  config: D1R2RestoreConfig,
  backupKey: string,
  fetcher: Fetcher = fetch,
  now = new Date(),
): Promise<D1R2RestorePlan> {
  validateConfig(config)
  const evidence = await readBackupEvidence(config, backupKey, fetcher, now)
  return restorePlan(config, evidence.manifest)
}

export async function executeD1R2Restore(input: {
  config: D1R2RestoreConfig
  backupKey: string
  confirmation: string
  options: RestoreOptions
}): Promise<D1R2RestoreReceipt> {
  validateConfig(input.config)
  const expected = d1R2RestoreConfirmation(input.config.stage, input.backupKey)
  if (input.confirmation !== expected) throw new Error("D1 R2 сэргээх баталгаажуулалт таарахгүй байна.")

  const fetcher = input.options.fetcher ?? fetch
  const now = input.options.now ?? (() => new Date())
  const evidence = await readBackupEvidence(input.config, input.backupKey, fetcher, now())
  const plan = restorePlan(input.config, evidence.manifest)
  await input.options.prepared?.(plan)

  const response = await downloadBackup(input.config, evidence, fetcher)
  const artifact = await input.options.materialize(response, evidence.manifest)
  let databaseId: string | undefined
  let receipt: D1R2RestoreReceipt | undefined
  let primaryError: unknown
  let preserveDatabase = false
  try {
    validateMaterializedBackup(artifact, evidence)
    const createdDatabaseId = await createRecoveryDatabase(input.config, plan.recoveryDatabaseName, fetcher)
    if (createdDatabaseId.toLowerCase() === input.config.sourceDatabaseId.toLowerCase()) {
      throw new Error("Recovery D1 нь эх өгөгдлийн сантай ижил байж болохгүй.")
    }
    databaseId = createdDatabaseId
    await input.options.restore({
      accountId: input.config.accountId,
      databaseId,
      databaseName: plan.recoveryDatabaseName,
      artifact,
      apiToken: input.config.apiToken,
    })
    const verifiedTables = await verifyRecoveryDatabase(input.config, databaseId, fetcher)
    preserveDatabase = true
    receipt = {
      version: 1,
      kind: "mongolgpt-d1-r2-restore",
      stage: input.config.stage,
      backupKeySha256: plan.backupKeySha256,
      backupCreatedAt: plan.backupCreatedAt,
      backupSize: plan.backupSize,
      recoveryDatabaseName: plan.recoveryDatabaseName,
      verifiedTables,
      integrityCheck: "ok",
      completedAt: now().toISOString(),
    }
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors: unknown[] = []
    if (databaseId && !preserveDatabase) {
      try {
        await deleteRecoveryDatabase(input.config, databaseId, fetcher)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await artifact.cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
    throwCombinedErrors(primaryError, cleanupErrors)
  }
  if (!receipt) throw new Error("D1 R2 сэргээх ажиллагаа үр дүнгүй дууслаа.")
  return receipt
}

export function buildD1R2RestoreChildEnvironment(
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

function restorePlan(config: D1R2RestoreConfig, manifest: D1BackupManifest): D1R2RestorePlan {
  return {
    version: 1,
    kind: "mongolgpt-d1-r2-restore-plan",
    stage: config.stage,
    backupKeySha256: createHash("sha256").update(manifest.artifact.key).digest("hex"),
    backupCreatedAt: manifest.createdAt,
    backupSize: manifest.artifact.size,
    recoveryDatabaseName: d1R2RecoveryDatabaseName(config.stage, config.operationId),
    confirmation: d1R2RestoreConfirmation(config.stage, manifest.artifact.key),
  }
}

async function readBackupEvidence(config: D1R2RestoreConfig, backupKey: string, fetcher: Fetcher, now: Date) {
  const manifestKey = d1BackupManifestKey(backupKey)
  const query = new URLSearchParams({ per_page: "10", prefix: backupKey })
  const envelope = await cloudflareJson(
    config,
    `/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(config.backupBucket)}/objects?${query}`,
    { method: "GET" },
    fetcher,
  )
  if (!Array.isArray(envelope.result)) throw new Error("Cloudflare R2 object жагсаалтын бүтэц буруу байна.")
  if (record(envelope.result_info) && envelope.result_info.is_truncated === true) {
    throw new Error("D1 backup object жагсаалт тодорхой бус байна.")
  }
  const objects = envelope.result.map(parseR2Object)
  const artifact = exactlyOne(objects, backupKey, "D1 backup SQL")
  const manifestObject = exactlyOne(objects, manifestKey, "D1 backup manifest")
  if (manifestObject.size > D1_BACKUP_MANIFEST_MAX_BYTES || manifestObject.contentType !== "application/json") {
    throw new Error("D1 backup manifest object metadata буруу байна.")
  }
  validateManifestObjectMetadata(manifestObject, config)

  const response = await cloudflareFetch(config, r2ObjectPath(config, manifestKey), { method: "GET" }, fetcher)
  requireResponseMetadata(response, manifestObject, "D1 backup manifest")
  const body = await readBoundedText(response, D1_BACKUP_MANIFEST_MAX_BYTES, "D1 backup manifest")
  const manifest = parseD1BackupManifest(body, { stage: config.stage, databaseId: config.sourceDatabaseId })
  if (manifest.artifact.key !== backupKey) throw new Error("D1 backup key manifest-тай таарахгүй байна.")
  if (manifest.artifact.size > D1_IMPORT_MAX_BYTES) {
    throw new Error("D1 backup SQL нь Cloudflare-ийн 5 GiB import хязгаараас их байна.")
  }
  const createdAt = new Date(manifest.createdAt)
  if (createdAt.getTime() - now.getTime() > FUTURE_CLOCK_SKEW_MS) {
    throw new Error("D1 backup manifest ирээдүйн хугацаатай байна.")
  }
  validateArtifactMetadata(artifact, manifest)
  return { manifest, artifact } satisfies BackupEvidence
}

async function downloadBackup(config: D1R2RestoreConfig, evidence: BackupEvidence, fetcher: Fetcher) {
  const response = await cloudflareFetch(
    config,
    r2ObjectPath(config, evidence.manifest.artifact.key),
    { method: "GET" },
    fetcher,
    R2_DOWNLOAD_TIMEOUT_MS,
  )
  requireResponseMetadata(response, evidence.artifact, "D1 backup SQL")
  if (!response.body) throw new Error("D1 backup SQL stream хоосон байна.")
  return response
}

function validateMaterializedBackup(artifact: MaterializedD1R2Backup, evidence: BackupEvidence) {
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > D1_IMPORT_MAX_BYTES) {
    throw new Error("Татсан D1 backup SQL хэмжээ буруу байна.")
  }
  if (artifact.size !== evidence.manifest.artifact.size) {
    throw new Error("Татсан D1 backup SQL хэмжээ manifest-тай зөрж байна.")
  }
  if (!/^[a-f0-9]{32}$/.test(artifact.md5) || artifact.md5 !== normalizedEtag(evidence.manifest.artifact.etag)) {
    throw new Error("Татсан D1 backup SQL checksum manifest-тай зөрж байна.")
  }
}

async function createRecoveryDatabase(config: D1R2RestoreConfig, name: string, fetcher: Fetcher) {
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
  if (!databaseId || !databaseIdPattern(databaseId)) throw new Error("Recovery D1 ID буруу байна.")
  return databaseId
}

async function verifyRecoveryDatabase(config: D1R2RestoreConfig, databaseId: string, fetcher: Fetcher) {
  const names = REQUIRED_TABLES.map((name) => `'${name}'`).join(",")
  const schema = await queryDatabase(
    config,
    databaseId,
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${names}) ORDER BY name`,
    fetcher,
  )
  const verified = schema.map((row) => (record(row) ? boundedString(row.name, 128) : undefined)).filter(Boolean)
  if (verified.length !== REQUIRED_TABLES.length || REQUIRED_TABLES.some((name) => !verified.includes(name))) {
    throw new Error("Recovery D1-д зайлшгүй хүснэгтүүд дутуу байна.")
  }
  const integrity = await queryDatabase(config, databaseId, "PRAGMA integrity_check", fetcher)
  if (!integrity.some((row) => record(row) && Object.values(row).some((value) => value === "ok"))) {
    throw new Error("Recovery D1 integrity_check амжилтгүй боллоо.")
  }
  return [...REQUIRED_TABLES]
}

async function queryDatabase(config: D1R2RestoreConfig, databaseId: string, sql: string, fetcher: Fetcher) {
  const envelope = await cloudflareJson(
    config,
    `/accounts/${config.accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params: [] }),
    },
    fetcher,
  )
  const result = Array.isArray(envelope.result) ? envelope.result[0] : envelope.result
  if (!record(result) || result.success !== true || !Array.isArray(result.results)) {
    throw new Error("Recovery D1 query хариуны бүтэц буруу байна.")
  }
  return result.results
}

async function deleteRecoveryDatabase(config: D1R2RestoreConfig, databaseId: string, fetcher: Fetcher) {
  await cloudflareJson(config, `/accounts/${config.accountId}/d1/database/${databaseId}`, { method: "DELETE" }, fetcher)
}

function validateArtifactMetadata(artifact: R2Object, manifest: D1BackupManifest) {
  if (!/^[a-f0-9]{32}$/.test(normalizedEtag(manifest.artifact.etag))) {
    throw new Error("D1 backup SQL manifest checksum буруу байна.")
  }
  if (
    artifact.size !== manifest.artifact.size ||
    normalizedEtag(artifact.etag) !== normalizedEtag(manifest.artifact.etag) ||
    artifact.contentType !== manifest.artifact.contentType
  ) {
    throw new Error("D1 backup SQL object metadata manifest-тай зөрж байна.")
  }
  const metadata = artifact.customMetadata
  if (
    metadata.source !== "cloudflare-d1-export" ||
    metadata.stage !== manifest.stage ||
    metadata.databaseId?.toLowerCase() !== manifest.databaseId.toLowerCase() ||
    metadata.manifestVersion !== String(manifest.version) ||
    metadata.createdAt !== manifest.createdAt
  ) {
    throw new Error("D1 backup SQL custom metadata буруу байна.")
  }
}

function validateManifestObjectMetadata(object: R2Object, config: D1R2RestoreConfig) {
  const metadata = object.customMetadata
  if (
    metadata.source !== "mongolgpt-d1-backup-manifest" ||
    metadata.stage !== config.stage ||
    metadata.databaseId?.toLowerCase() !== config.sourceDatabaseId.toLowerCase() ||
    metadata.version !== "1"
  ) {
    throw new Error("D1 backup manifest custom metadata буруу байна.")
  }
}

function requireResponseMetadata(response: Response, object: R2Object, label: string) {
  const length = Number(response.headers.get("content-length"))
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  const etag = response.headers.get("etag")
  if (
    !Number.isSafeInteger(length) ||
    length !== object.size ||
    contentType !== object.contentType ||
    normalizedEtag(etag ?? "") !== normalizedEtag(object.etag)
  ) {
    throw new Error(`${label} HTTP metadata зөрж байна.`)
  }
}

function parseR2Object(value: unknown): R2Object {
  if (!record(value)) throw new Error("Cloudflare R2 object-ийн бүтэц буруу байна.")
  const key = boundedString(value.key, 1024)
  const etag = boundedString(value.etag, 1024)
  const httpMetadata = record(value.http_metadata) ? value.http_metadata : undefined
  const contentType = boundedString(httpMetadata?.contentType, 128)?.toLowerCase()
  const customMetadata = stringRecord(value.custom_metadata)
  if (!key || !etag || !contentType || !Number.isSafeInteger(value.size) || Number(value.size) <= 0) {
    throw new Error("Cloudflare R2 object-ийн бүтэц буруу байна.")
  }
  return { key, etag: normalizedEtag(etag), size: Number(value.size), contentType, customMetadata }
}

function exactlyOne(objects: R2Object[], key: string, label: string) {
  const matches = objects.filter((object) => object.key === key)
  if (matches.length !== 1) throw new Error(`${label} яг нэг ширхэг олдсонгүй.`)
  return matches[0]
}

async function cloudflareJson(config: D1R2RestoreConfig, path: string, init: RequestInit, fetcher: Fetcher) {
  const response = await cloudflareFetch(config, path, init, fetcher)
  const body = await readBoundedText(response, MAX_API_RESPONSE_BYTES, "Cloudflare API")
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new Error("Cloudflare API зөв JSON буцаасангүй.")
  }
  if (!record(value) || value.success !== true) throw new Error(apiError(value))
  return value
}

async function cloudflareFetch(
  config: D1R2RestoreConfig,
  path: string,
  init: RequestInit,
  fetcher: Fetcher,
  timeoutMs = 30_000,
) {
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${config.apiToken}`)
  const response = await fetcher(`${API_ROOT}${path}`, {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`Cloudflare API HTTP ${response.status} буцаалаа.`)
  return response
}

async function readBoundedText(response: Response, limit: number, label: string) {
  const header = response.headers.get("content-length")
  if (header !== null) {
    const declared = Number(header)
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > limit)
      throw new Error(`${label} хариу хэт том байна.`)
  }
  const body = await response.text()
  if (new TextEncoder().encode(body).byteLength > limit) throw new Error(`${label} хариу хэт том байна.`)
  return body
}

function r2ObjectPath(config: D1R2RestoreConfig, key: string) {
  const objectKey = key.split("/").map(encodeURIComponent).join("/")
  return `/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(config.backupBucket)}/objects/${objectKey}`
}

function validateConfig(config: D1R2RestoreConfig) {
  if (config.stage !== "dev" && config.stage !== "production") throw new TypeError("D1 R2 сэргээх орчин буруу байна.")
  if (!/^[a-f0-9]{32}$/i.test(config.accountId)) throw new TypeError("Cloudflare account ID буруу байна.")
  if (!databaseIdPattern(config.sourceDatabaseId)) throw new TypeError("Эх D1 database ID буруу байна.")
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(config.backupBucket))
    throw new TypeError("R2 backup bucket буруу байна.")
  if (!config.apiToken.trim() || config.apiToken.length > 512)
    throw new TypeError("Cloudflare D1 R2 restore token буруу байна.")
  d1R2RecoveryDatabaseName(config.stage, config.operationId)
}

function throwCombinedErrors(primaryError: unknown, cleanupErrors: unknown[]) {
  if (primaryError !== undefined) {
    if (!cleanupErrors.length) throw primaryError
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `D1 R2 restore амжилтгүй болсон (${errorMessage(primaryError)}), мөн цэвэрлэгээний ${cleanupErrors.length} алдаа гарлаа.`,
      { cause: primaryError },
    )
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1)
    throw new AggregateError(cleanupErrors, `D1 R2 restore-ийн цэвэрлэгээнд ${cleanupErrors.length} алдаа гарлаа.`)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "тодорхойгүй алдаа"
}

function databaseIdPattern(value: string) {
  return /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
}

function normalizedEtag(value: string) {
  return value.trim().replace(/^W\//, "").replace(/^"|"$/g, "").toLowerCase()
}

function stringRecord(value: unknown) {
  if (!record(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
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

function apiError(value: unknown) {
  if (!record(value) || !Array.isArray(value.errors)) return "Cloudflare API хүсэлт амжилтгүй боллоо."
  const messages = value.errors
    .slice(0, 3)
    .map((error) => {
      if (!record(error)) return undefined
      const code = typeof error.code === "number" ? error.code : "unknown"
      const message = boundedString(error.message, 256)
      return message ? `${code}: ${message}` : undefined
    })
    .filter(Boolean)
  return messages.length ? `Cloudflare API алдаа: ${messages.join("; ")}` : "Cloudflare API хүсэлт амжилтгүй боллоо."
}
