const CLOUDFLARE_API_ROOT = "https://api.cloudflare.com/client/v4"
const DATABASE_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i
const BOOKMARK = /^[a-z0-9_-]{16,256}$/i

export type D1RestoreStage = "dev" | "production"
export type D1RestoreTarget = { kind: "bookmark"; value: string } | { kind: "timestamp"; value: string }

export type D1RestoreConfig = {
  accountId: string
  databaseId: string
  apiToken: string
  stage: D1RestoreStage
}

export type D1RestorePlan = {
  stage: D1RestoreStage
  databaseId: string
  target: D1RestoreTarget
  targetBookmark: string
  currentBookmark: string
  confirmation: string
}

export type D1RestoreReceipt = D1RestorePlan & {
  restoredBookmark: string
  previousBookmark: string
  previousBookmarkMatchesPlan: boolean
  message: string
  restoredAt: string
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type CloudflareError = { code?: number; message?: string }
type CloudflareEnvelope<T> = {
  success?: boolean
  result?: T
  errors?: CloudflareError[]
}

export function normalizeD1RestoreTarget(target: D1RestoreTarget): D1RestoreTarget {
  const value = target.value.trim()
  if (target.kind === "bookmark") {
    if (!BOOKMARK.test(value)) throw new Error("D1 сэргээх bookmark-ийн формат буруу байна.")
    return { kind: "bookmark", value }
  }

  const parsed = new Date(value)
  if (!value || Number.isNaN(parsed.valueOf())) throw new Error("D1 сэргээх хугацаа ISO 8601 форматтай байх ёстой.")
  return { kind: "timestamp", value: parsed.toISOString() }
}

export function d1RestoreConfirmation(stage: D1RestoreStage, target: D1RestoreTarget) {
  const normalized = normalizeD1RestoreTarget(target)
  return `RESTORE D1 ${stage} ${normalized.value}`
}

export function validateD1RestoreConfig(config: D1RestoreConfig) {
  if (config.stage !== "dev" && config.stage !== "production")
    throw new Error("D1 сэргээх орчин dev эсвэл production байх ёстой.")
  if (!/^[a-f0-9]{32}$/i.test(config.accountId.trim())) throw new Error("Cloudflare account ID-ийн формат буруу байна.")
  if (!DATABASE_ID.test(config.databaseId.trim())) throw new Error("Cloudflare D1 database ID-ийн формат буруу байна.")
  if (!config.apiToken.trim() || config.apiToken.length > 512)
    throw new Error("D1 сэргээх API token дутуу эсвэл буруу байна.")
}

export async function planD1Restore(
  config: D1RestoreConfig,
  target: D1RestoreTarget,
  fetcher: Fetcher = fetch,
): Promise<D1RestorePlan> {
  validateD1RestoreConfig(config)
  const normalized = normalizeD1RestoreTarget(target)
  const currentBookmark = await getBookmark(config, undefined, fetcher)
  const targetBookmark =
    normalized.kind === "bookmark" ? normalized.value : await getBookmark(config, normalized.value, fetcher)

  if (currentBookmark === targetBookmark)
    throw new Error("Сэргээх цэг нь D1 өгөгдлийн сангийн одоогийн төлөвтэй ижил байна.")

  return {
    stage: config.stage,
    databaseId: config.databaseId,
    target: normalized,
    targetBookmark,
    currentBookmark,
    confirmation: d1RestoreConfirmation(config.stage, normalized),
  }
}

export async function executeD1Restore(input: {
  config: D1RestoreConfig
  target: D1RestoreTarget
  confirmation: string
  fetcher?: Fetcher
  now?: () => Date
  prepared?: (plan: D1RestorePlan) => Promise<void>
}): Promise<D1RestoreReceipt> {
  const expected = d1RestoreConfirmation(input.config.stage, input.target)
  if (input.confirmation !== expected)
    throw new Error(`D1 сэргээх баталгаажуулалт таарахгүй байна. Яг ингэж бичнэ: ${expected}`)

  const fetcher = input.fetcher ?? fetch
  const plan = await planD1Restore(input.config, input.target, fetcher)
  await input.prepared?.(plan)

  const query = new URLSearchParams({ bookmark: plan.targetBookmark })
  const result = await cloudflareRequest<{ bookmark?: string; previous_bookmark?: string; message?: string }>(
    input.config,
    `/time_travel/restore?${query}`,
    { method: "POST" },
    fetcher,
  )
  const restoredBookmark = requiredBookmark(result.bookmark, "Сэргээсний дараах bookmark")
  const previousBookmark = requiredBookmark(result.previous_bookmark, "Сэргээхийн өмнөх bookmark")

  return {
    ...plan,
    restoredBookmark,
    previousBookmark,
    previousBookmarkMatchesPlan: previousBookmark === plan.currentBookmark,
    message: result.message?.trim() || "D1 өгөгдлийн сан амжилттай сэргээгдлээ.",
    restoredAt: (input.now ?? (() => new Date()))().toISOString(),
  }
}

async function getBookmark(config: D1RestoreConfig, timestamp: string | undefined, fetcher: Fetcher) {
  const query = timestamp ? `?${new URLSearchParams({ timestamp })}` : ""
  const result = await cloudflareRequest<{ bookmark?: string }>(
    config,
    `/time_travel/bookmark${query}`,
    { method: "GET" },
    fetcher,
  )
  return requiredBookmark(result.bookmark, timestamp ? "Зорилтот bookmark" : "Одоогийн bookmark")
}

async function cloudflareRequest<T>(
  config: D1RestoreConfig,
  suffix: string,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<T> {
  const url = `${CLOUDFLARE_API_ROOT}/accounts/${config.accountId}/d1/database/${config.databaseId}${suffix}`
  const response = await fetcher(url, {
    ...init,
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      accept: "application/json",
    },
  })
  const payload = (await response.json().catch(() => undefined)) as CloudflareEnvelope<T> | undefined
  if (!response.ok || payload?.success !== true || !payload.result) {
    const detail = payload?.errors
      ?.map((error) => [error.code, error.message].filter(Boolean).join(": "))
      .filter(Boolean)
      .join("; ")
    throw new Error(`Cloudflare D1 API хүсэлт амжилтгүй боллоо (${response.status})${detail ? `: ${detail}` : "."}`)
  }
  return payload.result
}

function requiredBookmark(value: unknown, label: string) {
  if (typeof value !== "string" || !BOOKMARK.test(value)) throw new Error(`${label} Cloudflare-ийн хариунд алга байна.`)
  return value
}
