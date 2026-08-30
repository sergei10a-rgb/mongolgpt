const API_ROOT = "https://api.cloudflare.com/client/v4"
const MAX_API_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_POLL_ATTEMPTS = 180
const DEFAULT_POLL_DELAY_MS = 10_000
const ACTIVE_STATUSES = new Set(["queued", "running", "waiting", "rollingBack"])
const FAILED_STATUSES = new Set(["errored", "terminated", "paused", "waitingForPause"])

export type D1BackupRehearsalConfig = {
  accountId: string
  workflowName: string
  apiToken: string
  stage: "dev"
  runId: string
}

export type D1BackupRehearsalReceipt = {
  version: 1
  kind: "mongolgpt-d1-backup-rehearsal"
  stage: "dev"
  workflowName: string
  instanceId: string
  scheduledTime: string
  completedAt: string
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function executeD1BackupRehearsal(
  config: D1BackupRehearsalConfig,
  options: {
    fetcher?: Fetcher
    now?: () => Date
    sleep?: (milliseconds: number) => Promise<void>
    instanceId?: string
    pollAttempts?: number
    pollDelayMs?: number
  } = {},
) {
  validateConfig(config)
  const now = options.now ?? (() => new Date())
  const scheduledTime = now()
  if (!Number.isFinite(scheduledTime.getTime())) throw new Error("D1 нөөцлөлтийн сургуулилалтын хугацаа буруу байна.")
  const instanceId = options.instanceId ?? `mongolgpt-dev-backup-${config.runId}-${crypto.randomUUID()}`
  validateInstanceId(instanceId)
  const fetcher = options.fetcher ?? fetch
  const endpoint = `${API_ROOT}/accounts/${encodeURIComponent(config.accountId)}/workflows/${encodeURIComponent(config.workflowName)}/instances`
  const created = await requestCloudflare(
    endpoint,
    {
      method: "POST",
      headers: authorization(config.apiToken, true),
      body: JSON.stringify({
        instance_id: instanceId,
        instance_retention: { success_retention: "30 days", error_retention: "30 days" },
        params: JSON.stringify({ scheduledTime: scheduledTime.getTime() }),
      }),
    },
    fetcher,
  )
  const createdInstance = requireInstance(created)
  if (createdInstance.id !== instanceId) throw new Error("Cloudflare Workflow өөр instance ID буцаалаа.")

  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS
  const pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > DEFAULT_POLL_ATTEMPTS) {
    throw new Error("D1 нөөцлөлтийн pollAttempts 1-180 хооронд байна.")
  }
  if (!Number.isSafeInteger(pollDelayMs) || pollDelayMs < 0 || pollDelayMs > 60_000) {
    throw new Error("D1 нөөцлөлтийн pollDelayMs 0-60000 хооронд байна.")
  }
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds))

  for (const attempt of Array.from({ length: pollAttempts }, (_, index) => index)) {
    const current = requireInstance(
      await requestCloudflare(
        `${endpoint}/${encodeURIComponent(instanceId)}`,
        { headers: authorization(config.apiToken) },
        fetcher,
      ),
    )
    if (current.id !== instanceId) throw new Error("Cloudflare Workflow poll өөр instance ID буцаалаа.")
    if (current.status === "complete") {
      return {
        version: 1,
        kind: "mongolgpt-d1-backup-rehearsal",
        stage: "dev",
        workflowName: config.workflowName,
        instanceId,
        scheduledTime: scheduledTime.toISOString(),
        completedAt: now().toISOString(),
      } satisfies D1BackupRehearsalReceipt
    }
    if (FAILED_STATUSES.has(current.status)) {
      throw new Error(`Cloudflare D1 нөөцлөлтийн workflow ${current.status} төлөвтэй дууслаа.`)
    }
    if (!ACTIVE_STATUSES.has(current.status)) {
      throw new Error(`Cloudflare D1 нөөцлөлтийн workflow үл таних ${current.status} төлөв буцаалаа.`)
    }
    if (attempt < pollAttempts - 1) await sleep(pollDelayMs)
  }
  throw new Error("Cloudflare D1 нөөцлөлтийн workflow 30 минутын дотор дууссангүй.")
}

function validateConfig(config: D1BackupRehearsalConfig) {
  if (config.stage !== "dev") throw new Error("D1 нөөцлөлтийн сургуулилалт зөвхөн dev орчинд ажиллана.")
  if (!/^[a-f0-9]{32}$/i.test(config.accountId)) throw new Error("Cloudflare account ID буруу байна.")
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(config.workflowName)) throw new Error("Cloudflare Workflow нэр буруу байна.")
  if (!config.apiToken.trim() || config.apiToken.length > 512) throw new Error("CLOUDFLARE_API_TOKEN буруу байна.")
  if (!/^[0-9]{1,24}$/.test(config.runId)) throw new Error("GitHub run ID буруу байна.")
}

function validateInstanceId(value: string) {
  if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(value) || /^cf_[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Cloudflare Workflow instance ID буруу байна.")
  }
}

function authorization(token: string, json = false) {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  }
}

async function requestCloudflare(url: string, init: RequestInit, fetcher: Fetcher) {
  const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) })
  const body = await readBoundedText(response)
  const value = parseObject(body)
  if (!response.ok || value.success !== true) throw new Error(cloudflareError(value, response.status))
  if (!record(value.result)) throw new Error("Cloudflare Workflow API result объект буцаасангүй.")
  return value.result
}

async function readBoundedText(response: Response) {
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > MAX_API_RESPONSE_BYTES)
    throw new Error("Cloudflare Workflow API хэт том хариу буцаалаа.")
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_API_RESPONSE_BYTES) throw new Error("Cloudflare Workflow API хэт том хариу буцаалаа.")
      parts.push(decoder.decode(part.value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join("")
  } finally {
    reader.releaseLock()
  }
}

function parseObject(body: string) {
  if (!body.trim()) throw new Error("Cloudflare Workflow API хоосон хариу буцаалаа.")
  const value = (() => {
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new Error("Cloudflare Workflow API зөв JSON буцаасангүй.")
    }
  })()
  if (!record(value)) throw new Error("Cloudflare Workflow API-ийн хариу объект биш байна.")
  return value
}

function requireInstance(value: Record<string, unknown>) {
  if (typeof value.id !== "string" || !value.id) throw new Error("Cloudflare Workflow instance ID буцаасангүй.")
  if (typeof value.status !== "string" || !value.status)
    throw new Error("Cloudflare Workflow instance төлөв буцаасангүй.")
  return { id: value.id, status: value.status }
}

function cloudflareError(value: Record<string, unknown>, status: number) {
  const errors = Array.isArray(value.errors) ? value.errors : []
  const messages = errors
    .slice(0, 3)
    .filter(record)
    .map((error) => error.message)
    .filter(
      (message): message is string => typeof message === "string" && Boolean(message.trim()) && message.length <= 256,
    )
  return messages.length
    ? `Cloudflare Workflow API алдаа: ${messages.join("; ")}`
    : `Cloudflare Workflow API HTTP ${status} буцаалаа.`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
