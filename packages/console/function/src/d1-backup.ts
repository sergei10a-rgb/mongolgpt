const CLOUDFLARE_API_ROOT = "https://api.cloudflare.com/client/v4"
const MAX_API_RESPONSE_BYTES = 64 * 1024
const MAX_BACKUP_BYTES = 10 * 1024 * 1024 * 1024

export const D1_BACKUP_PREFIX = "d1/"

export type D1BackupConfig = {
  accountId: string
  databaseId: string
  apiToken: string
  stage: string
}

export type BackupBucket = {
  put(
    key: string,
    value: ReadableStream,
    options: {
      httpMetadata: { contentType: string }
      customMetadata: Record<string, string>
    },
  ): Promise<{ etag: string; size: number } | null>
}

export type BackupReceipt = {
  key: string
  etag: string
  size: number
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type ExportProgress = {
  bookmark?: string
  status?: string
  error?: string
  filename?: string
  signedUrl?: string
}

export async function startD1Export(config: D1BackupConfig, fetcher: Fetcher = fetch) {
  validateConfig(config)
  const progress = await requestExport(config, { output_format: "polling" }, fetcher)
  if (!progress.bookmark) throw new Error("D1 export-ийн хариуд bookmark алга байна")
  return progress.bookmark
}

export async function storeCompletedD1Export(input: {
  config: D1BackupConfig
  bookmark: string
  scheduledTime: number
  bucket: BackupBucket
  fetcher?: Fetcher
}): Promise<BackupReceipt> {
  validateConfig(input.config)
  const bookmark = requiredString(input.bookmark, "D1 export bookmark", 1024)
  const fetcher = input.fetcher ?? fetch
  const progress = await requestExport(input.config, { current_bookmark: bookmark }, fetcher)
  if (progress.status === "error" || progress.error) {
    throw new Error(`D1 export амжилтгүй боллоо${progress.error ? `: ${safeMessage(progress.error)}` : ""}`)
  }
  if (!progress.signedUrl || !progress.filename || (progress.status && progress.status !== "complete")) {
    throw new Error("D1 export бэлэн болоогүй байна")
  }

  const signedUrl = validateSignedDownloadUrl(progress.signedUrl)
  const key = backupObjectKey(input.config.stage, input.scheduledTime, progress.filename)
  const dump = await fetcher(signedUrl, { method: "GET", redirect: "error" })
  if (!dump.ok || !dump.body) throw new Error(`D1 export татаж авахад амжилтгүй боллоо, HTTP ${dump.status}`)
  if (dump.url) validateSignedDownloadUrl(dump.url)
  validateContentLength(dump.headers.get("content-length"))
  const cappedDump = capBackupStream(dump.body)

  let stored: Awaited<ReturnType<BackupBucket["put"]>>
  try {
    stored = await input.bucket.put(key, cappedDump.stream, {
      httpMetadata: { contentType: "application/sql" },
      customMetadata: {
        createdAt: new Date(input.scheduledTime).toISOString(),
        source: "cloudflare-d1-export",
        stage: input.config.stage,
      },
    })
  } catch (error) {
    if (cappedDump.exceeded()) {
      throw new Error("D1 export татаж авах хэмжээ зөвшөөрөгдөх дээд хязгаараас хэтэрлээ", { cause: error })
    }
    throw error
  }
  if (
    cappedDump.exceeded() ||
    !stored ||
    !Number.isSafeInteger(stored.size) ||
    stored.size <= 0 ||
    stored.size > MAX_BACKUP_BYTES ||
    !stored.etag
  ) {
    throw new Error("R2 D1 нөөц хуулбарын объектыг баталгаажуулсангүй")
  }
  return { key, etag: stored.etag, size: stored.size }
}

export function backupObjectKey(stage: string, scheduledTime: number, filename: string) {
  const normalizedStage = validateStage(stage)
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0 || scheduledTime > 8_640_000_000_000_000) {
    throw new TypeError("D1 нөөц хуулбарын timestamp буруу байна")
  }
  const date = new Date(scheduledTime)
  if (Number.isNaN(date.getTime())) throw new TypeError("D1 нөөц хуулбарын timestamp буруу байна")
  const [day] = date.toISOString().split("T")
  const timestamp = date.toISOString().replaceAll(":", "-")
  return `${D1_BACKUP_PREFIX}${normalizedStage}/${day.replaceAll("-", "/")}/${timestamp}-${safeFilename(filename)}`
}

export function scheduledBackupTime(payloadTime: unknown, eventTime: Date) {
  if (!(eventTime instanceof Date) || Number.isNaN(eventTime.getTime())) {
    throw new TypeError("D1 нөөц хуулбарын event-ийн хугацаа буруу байна")
  }
  if (payloadTime === undefined) return eventTime.getTime()
  if (typeof payloadTime !== "number" || !Number.isSafeInteger(payloadTime) || payloadTime < 0) {
    throw new TypeError("D1 нөөц хуулбарын товлосон хугацаа буруу байна")
  }
  return payloadTime
}

async function requestExport(config: D1BackupConfig, payload: Record<string, string>, fetcher: Fetcher) {
  const response = await fetcher(exportUrl(config), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`Cloudflare D1 export API HTTP ${response.status} буцаалаа`)
  const body = await response.text()
  if (body.length > MAX_API_RESPONSE_BYTES) throw new Error("Cloudflare D1 export-ийн хариу хэт том байна")

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error("Cloudflare D1 export-ийн хариу зөв JSON биш байна")
  }
  if (!record(parsed) || parsed.success !== true || !record(parsed.result)) {
    throw new Error(apiErrorMessage(parsed))
  }

  const result = parsed.result
  if (result.success === false || result.status === "error") {
    throw new Error(
      `D1 export амжилтгүй боллоо${typeof result.error === "string" ? `: ${safeMessage(result.error)}` : ""}`,
    )
  }
  const completed = record(result.result) ? result.result : result
  return {
    bookmark: optionalString(result.at_bookmark, 1024),
    status: optionalString(result.status, 64),
    error: optionalString(result.error, 512),
    filename: optionalString(completed.filename, 512),
    signedUrl: optionalString(completed.signed_url, 8192),
  } satisfies ExportProgress
}

function exportUrl(config: D1BackupConfig) {
  return `${CLOUDFLARE_API_ROOT}/accounts/${config.accountId}/d1/database/${config.databaseId}/export`
}

function validateConfig(config: D1BackupConfig) {
  if (!/^[a-f0-9]{32}$/i.test(config.accountId)) throw new TypeError("Cloudflare account ID буруу байна")
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(config.databaseId)) {
    throw new TypeError("Cloudflare D1 database ID буруу байна")
  }
  requiredString(config.apiToken, "Cloudflare D1 backup token", 512)
  validateStage(config.stage)
}

function validateStage(value: string) {
  const stage = requiredString(value, "MongolGPT stage", 63).toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(stage)) throw new TypeError("MongolGPT stage буруу байна")
  return stage
}

function validateSignedDownloadUrl(value: string) {
  if (value.length > 8192) throw new Error("D1 export татах URL хэт урт байна")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("D1 export татах URL буруу байна")
  }
  if (url.protocol !== "https:" || url.username || url.password || privateHostname(url.hostname)) {
    throw new Error("D1 export татах URL зөвшөөрөгдөөгүй байна")
  }
  return url.toString()
}

function privateHostname(value: string) {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "")
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return true
  }
  if (hostname.includes(":")) return true
  const parts = hostname.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  )
}

function validateContentLength(value: string | null) {
  if (value === null) return
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_BACKUP_BYTES) {
    throw new Error("D1 export татах хэмжээ буруу байна")
  }
}

function capBackupStream(body: ReadableStream<Uint8Array>) {
  let bytes = 0
  let exceeded = false
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (
          !Number.isSafeInteger(chunk.byteLength) ||
          chunk.byteLength < 0 ||
          bytes > MAX_BACKUP_BYTES - chunk.byteLength
        ) {
          exceeded = true
          throw new Error("D1 export татаж авах хэмжээ зөвшөөрөгдөх дээд хязгаараас хэтэрлээ")
        }
        bytes += chunk.byteLength
        controller.enqueue(chunk)
      },
    }),
  )
  return { stream, exceeded: () => exceeded }
}

function safeFilename(value: string) {
  const leaf = value.split(/[\\/]/).at(-1) ?? "database.sql"
  const safe = leaf
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
  if (!safe) return "database.sql"
  return safe.toLowerCase().endsWith(".sql") ? safe : `${safe}.sql`
}

function apiErrorMessage(value: unknown) {
  if (!record(value) || !Array.isArray(value.errors)) return "Cloudflare D1 export-ийн хариу буруу байна"
  const first = value.errors.find(record)
  if (!first) return "Cloudflare D1 export-ийн хүсэлт амжилтгүй боллоо"
  const code = typeof first.code === "number" ? ` (${first.code})` : ""
  const message = typeof first.message === "string" ? `: ${safeMessage(first.message)}` : ""
  return `Cloudflare D1 export-ийн хүсэлт амжилтгүй боллоо${code}${message}`
}

function requiredString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new TypeError(`${label} буруу байна`)
  return value.trim()
}

function optionalString(value: unknown, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) return undefined
  return value.trim()
}

function safeMessage(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 160)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
