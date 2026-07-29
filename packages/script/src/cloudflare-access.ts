const apiOrigin = "https://api.cloudflare.com/client/v4"
const maxResponseBytes = 32 * 1024
const mfaSessionDuration = "24h"

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const cloudflareAccessMfaAuthenticators = ["totp", "biometrics", "security_key"] as const

export class CloudflareAccessPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CloudflareAccessPreflightError"
  }
}

export async function preflightCloudflareAccess(input: {
  accountId: string
  token: string
  fetcher?: Fetcher
  timeoutMs?: number
}) {
  const accountId = input.accountId.trim()
  const token = input.token.trim()
  if (!accountId) throw new CloudflareAccessPreflightError("Cloudflare account ID дутуу байна.")
  if (!token) throw new CloudflareAccessPreflightError("Cloudflare Access API token дутуу байна.")

  const options = () => ({
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  })
  const organization = await requestCloudflare(
    input.fetcher ?? fetch,
    `${apiOrigin}/accounts/${encodeURIComponent(accountId)}/access/organizations`,
    options(),
    "Zero Trust organization-ийг унших",
  )
  if (!record(organization.result) || typeof organization.result.auth_domain !== "string") {
    throw new CloudflareAccessPreflightError(
      "Cloudflare Zero Trust organization эхлүүлээгүй эсвэл team domain үүсээгүй байна.",
    )
  }
  const teamDomain = normalizeTeamDomain(organization.result.auth_domain)

  const identityProviders = await requestCloudflare(
    input.fetcher ?? fetch,
    `${apiOrigin}/accounts/${encodeURIComponent(accountId)}/access/identity_providers?per_page=1`,
    options(),
    "Access нэвтрэх аргыг шалгах",
  )
  if (!Array.isArray(identityProviders.result) || identityProviders.result.length === 0) {
    throw new CloudflareAccessPreflightError(
      "Cloudflare Zero Trust-д дор хаяж нэг login method эсвэл identity provider тохируулна.",
    )
  }

  const applications = await requestCloudflare(
    input.fetcher ?? fetch,
    `${apiOrigin}/accounts/${encodeURIComponent(accountId)}/access/apps?per_page=1`,
    options(),
    "Access application жагсаалтыг унших",
  )
  if (!Array.isArray(applications.result)) {
    throw new CloudflareAccessPreflightError(
      "Cloudflare Access application жагсаалтын хариу танигдсан хэлбэртэй биш байна.",
    )
  }

  return { teamDomain }
}

export async function configureCloudflareAccessMfa(input: {
  accountId: string
  token: string
  fetcher?: Fetcher
  timeoutMs?: number
}) {
  const accountId = input.accountId.trim()
  const token = input.token.trim()
  if (!accountId) throw new CloudflareAccessPreflightError("Cloudflare account ID дутуу байна.")
  if (!token) throw new CloudflareAccessPreflightError("Cloudflare Access API token дутуу байна.")

  const fetcher = input.fetcher ?? fetch
  const url = `${apiOrigin}/accounts/${encodeURIComponent(accountId)}/access/organizations`
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  }
  const organization = await requestCloudflare(
    fetcher,
    url,
    {
      headers,
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    },
    "Zero Trust organization-ийг унших",
  )
  if (!record(organization.result) || typeof organization.result.auth_domain !== "string") {
    throw new CloudflareAccessPreflightError(
      "Cloudflare Zero Trust organization эхлүүлээгүй эсвэл team domain үүсээгүй байна.",
    )
  }

  const desired = mergeIndependentMfa(organization.result)
  const updated = await requestCloudflare(
    fetcher,
    url,
    {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(desired),
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    },
    "Zero Trust organization-ийн Independent MFA-г тохируулах",
  )
  if (
    !record(updated.result) ||
    typeof updated.result.auth_domain !== "string" ||
    !hasRequiredIndependentMfa(updated.result)
  ) {
    throw new CloudflareAccessPreflightError(
      "Cloudflare Zero Trust organization Independent MFA тохиргоог баталгаажуулсангүй.",
    )
  }

  return {
    teamDomain: normalizeTeamDomain(updated.result.auth_domain),
    authenticators: [...cloudflareAccessMfaAuthenticators],
  }
}

export function mergeIndependentMfa(organization: Record<string, unknown>): Record<string, unknown> {
  const currentMfa = record(organization.mfa_config) ? organization.mfa_config : {}
  const allowed = Array.isArray(currentMfa.allowed_authenticators)
    ? currentMfa.allowed_authenticators.filter((value): value is string => typeof value === "string")
    : []
  const allowedAuthenticators = [...new Set([...allowed, ...cloudflareAccessMfaAuthenticators])]

  return {
    ...organization,
    mfa_config: {
      ...currentMfa,
      allowed_authenticators: allowedAuthenticators,
      session_duration:
        typeof currentMfa.session_duration === "string" && currentMfa.session_duration.trim()
          ? currentMfa.session_duration
          : mfaSessionDuration,
    },
    mfa_required_for_all_apps:
      typeof organization.mfa_required_for_all_apps === "boolean" ? organization.mfa_required_for_all_apps : false,
  }
}

async function requestCloudflare(fetcher: Fetcher, url: string, options: RequestInit, operation: string) {
  const response = await fetcher(url, options).catch(() => {
    throw new CloudflareAccessPreflightError(`${operation} үед Cloudflare API-тай холбогдож чадсангүй.`)
  })
  const payload = await readResponse(response)
  if (!response.ok || payload.success !== true) {
    throw new CloudflareAccessPreflightError(`${operation} амжилтгүй боллоо (HTTP ${response.status}).`)
  }
  return payload
}

async function readResponse(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new CloudflareAccessPreflightError("Cloudflare API хэт том хариу буцаалаа.")
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") {
    throw new CloudflareAccessPreflightError("Cloudflare API JSON бус хариу буцаалаа.")
  }
  if (!response.body) {
    throw new CloudflareAccessPreflightError("Cloudflare API хоосон хариу буцаалаа.")
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
      throw new CloudflareAccessPreflightError("Cloudflare API хэт том хариу буцаалаа.")
    }
    text += decoder.decode(part.value, { stream: true })
  }
  text += decoder.decode()

  try {
    const payload: unknown = JSON.parse(text)
    if (!record(payload)) throw new Error("invalid payload")
    return payload
  } catch {
    throw new CloudflareAccessPreflightError("Cloudflare API хүчинтэй JSON буцаасангүй.")
  }
}

function hasRequiredIndependentMfa(organization: Record<string, unknown>) {
  if (typeof organization.auth_domain !== "string") return false
  if (!record(organization.mfa_config)) return false
  const allowed = organization.mfa_config.allowed_authenticators
  const duration = organization.mfa_config.session_duration
  return (
    Array.isArray(allowed) &&
    cloudflareAccessMfaAuthenticators.every((authenticator) => allowed.includes(authenticator)) &&
    typeof duration === "string" &&
    duration.trim().length > 0
  )
}

function normalizeTeamDomain(value: string) {
  const raw = value.trim()
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`)
    const validHostname = url.hostname !== "cloudflareaccess.com" && url.hostname.endsWith(".cloudflareaccess.com")
    if (
      url.protocol !== "https:" ||
      !validHostname ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    ) {
      throw new Error("invalid team domain")
    }
    return url.origin
  } catch {
    throw new CloudflareAccessPreflightError("Cloudflare Zero Trust organization-ийн team domain хүчинтэй биш байна.")
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
