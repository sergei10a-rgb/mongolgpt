const apiOrigin = "https://api.cloudflare.com/client/v4"
const maxResponseBytes = 32 * 1024

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class CloudflareDeploymentPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CloudflareDeploymentPreflightError"
  }
}

export async function preflightCloudflareDeploymentAccess(input: {
  accountId: string
  token: string
  domain: string
  scope?: "full" | "hosted-only" | "runtime-only" | "worker-only"
  fetcher?: Fetcher
  timeoutMs?: number
}) {
  const accountId = input.accountId.trim()
  const token = input.token.trim()
  const domain = input.domain.trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new CloudflareDeploymentPreflightError("Cloudflare account ID 32 тэмдэгт hexadecimal утгатай байна.")
  }
  if (!token) throw new CloudflareDeploymentPreflightError("Cloudflare deploy API token дутуу байна.")
  if (!validDomain(domain)) throw new CloudflareDeploymentPreflightError("Cloudflare deploy domain хүчинтэй биш байна.")

  const fetcher = input.fetcher ?? fetch
  const options = () => ({
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  })

  const verification = await requestCloudflare(
    fetcher,
    `${apiOrigin}/user/tokens/verify`,
    options(),
    "Cloudflare API token-ийн төлөвийг шалгах",
  )
  if (!record(verification.result) || verification.result.status !== "active") {
    throw new CloudflareDeploymentPreflightError("Cloudflare deploy API token идэвхтэй биш байна.")
  }

  const zoneQuery = new URLSearchParams({ name: domain, "account.id": accountId, per_page: "2" })
  const zones = await requestCloudflare(
    fetcher,
    `${apiOrigin}/zones?${zoneQuery.toString()}`,
    options(),
    `Cloudflare дахь ${domain} бүсийг унших`,
  )
  if (!Array.isArray(zones.result) || zones.result.length !== 1) {
    throw new CloudflareDeploymentPreflightError(
      `Cloudflare token ${domain} бүсийг сонгосон account-аас яг нэгээр уншиж чадсангүй. Zone Read болон resource scope-ийг шалгана.`,
    )
  }
  const zone = zones.result[0]
  if (
    !record(zone) ||
    typeof zone.id !== "string" ||
    zone.id.length === 0 ||
    typeof zone.name !== "string" ||
    zone.name.toLowerCase() !== domain ||
    !record(zone.account) ||
    zone.account.id !== accountId
  ) {
    throw new CloudflareDeploymentPreflightError("Cloudflare zone сонгосон domain болон account-тай тохирохгүй байна.")
  }

  const accountPath = `${apiOrigin}/accounts/${encodeURIComponent(accountId)}`
  await requireList(
    fetcher,
    `${accountPath}/workers/scripts`,
    options(),
    "Cloudflare Workers Scripts жагсаалтыг унших",
    "Workers Scripts Read эсвэл Edit",
  )
  if (input.scope === "worker-only") return { zoneId: zone.id, domain }

  if (input.scope !== "hosted-only") {
    await requireRecord(
      fetcher,
      `${accountPath}/containers/me`,
      options(),
      "Cloudflare Containers бүртгэлийн эрхийг шалгах",
      "Containers Edit",
    )
  }
  if (input.scope === "runtime-only") return { zoneId: zone.id, domain }

  await requireList(
    fetcher,
    `${accountPath}/d1/database?per_page=1`,
    options(),
    "Cloudflare D1 database жагсаалтыг унших",
    "D1 Read эсвэл Edit",
  )
  await requireList(
    fetcher,
    `${accountPath}/storage/kv/namespaces?per_page=1`,
    options(),
    "Cloudflare Workers KV namespace жагсаалтыг унших",
    "Workers KV Storage Read эсвэл Write",
  )
  await requireBucketList(
    fetcher,
    `${accountPath}/r2/buckets?per_page=1`,
    options(),
    "Cloudflare R2 bucket жагсаалтыг унших",
    "Workers R2 Storage Read эсвэл Write",
  )
  await requireList(
    fetcher,
    `${accountPath}/queues?per_page=1`,
    options(),
    "Cloudflare Queues жагсаалтыг унших",
    "Queues Read эсвэл Edit",
  )

  return { zoneId: zone.id, domain }
}

async function requireRecord(
  fetcher: Fetcher,
  url: string,
  options: RequestInit,
  operation: string,
  permission: string,
) {
  const payload = await requestCloudflare(fetcher, url, options, operation)
  if (!record(payload.result)) {
    throw new CloudflareDeploymentPreflightError(
      `${operation} хариу танигдсан объект биш байна. ${permission} эрхийг шалгана.`,
    )
  }
}

async function requireList(fetcher: Fetcher, url: string, options: RequestInit, operation: string, permission: string) {
  const payload = await requestCloudflare(fetcher, url, options, operation)
  if (!Array.isArray(payload.result)) {
    throw new CloudflareDeploymentPreflightError(
      `${operation} хариу танигдсан жагсаалт биш байна. ${permission} эрхийг шалгана.`,
    )
  }
}

async function requireBucketList(
  fetcher: Fetcher,
  url: string,
  options: RequestInit,
  operation: string,
  permission: string,
) {
  const payload = await requestCloudflare(fetcher, url, options, operation)
  if (!record(payload.result) || !Array.isArray(payload.result.buckets)) {
    throw new CloudflareDeploymentPreflightError(
      `${operation} хариу танигдсан жагсаалт биш байна. ${permission} эрхийг шалгана.`,
    )
  }
}

async function requestCloudflare(fetcher: Fetcher, url: string, options: RequestInit, operation: string) {
  const response = await fetcher(url, options).catch(() => {
    throw new CloudflareDeploymentPreflightError(`${operation} үед Cloudflare API-тай холбогдож чадсангүй.`)
  })
  const payload = await readResponse(response, operation)
  if (!response.ok || payload.success !== true) {
    throw new CloudflareDeploymentPreflightError(
      `${operation} амжилтгүй боллоо (HTTP ${response.status}). Token permission болон resource scope-ийг шалгана.`,
    )
  }
  return payload
}

async function readResponse(response: Response, operation: string) {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new CloudflareDeploymentPreflightError(`${operation}: Cloudflare API хэт том хариу буцаалаа.`)
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") {
    throw new CloudflareDeploymentPreflightError(`${operation}: Cloudflare API JSON бус хариу буцаалаа.`)
  }
  if (!response.body) {
    throw new CloudflareDeploymentPreflightError(`${operation}: Cloudflare API хоосон хариу буцаалаа.`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  while (true) {
    const part = await reader.read()
    if (part.done) break
    total += part.value.byteLength
    if (total > maxResponseBytes) {
      await reader.cancel()
      throw new CloudflareDeploymentPreflightError(`${operation}: Cloudflare API хэт том хариу буцаалаа.`)
    }
    text += decoder.decode(part.value, { stream: true })
  }
  text += decoder.decode()

  try {
    const payload: unknown = JSON.parse(text)
    if (!record(payload)) throw new Error("invalid payload")
    return payload
  } catch {
    throw new CloudflareDeploymentPreflightError(`${operation}: Cloudflare API хүчинтэй JSON буцаасангүй.`)
  }
}

function validDomain(value: string) {
  if (value.length === 0 || value.length > 253 || value.includes("..")) return false
  return (
    value.split(".").length >= 2 &&
    value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
