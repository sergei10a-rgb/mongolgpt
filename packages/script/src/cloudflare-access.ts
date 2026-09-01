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

export async function verifyCloudflareAdminAccess(input: {
  accountId: string
  token: string
  hostname: string
  stage: string
  bootstrapEmails: string
  fetcher?: Fetcher
  timeoutMs?: number
}) {
  const accountId = input.accountId.trim()
  const token = input.token.trim()
  const hostname = normalizeHostname(input.hostname)
  const stage = input.stage.trim()
  const bootstrapEmails = parseBootstrapEmails(input.bootstrapEmails)
  if (!accountId) throw new CloudflareAccessPreflightError("Cloudflare account ID дутуу байна.")
  if (!token) throw new CloudflareAccessPreflightError("Cloudflare Access API token дутуу байна.")
  if (!stage) throw new CloudflareAccessPreflightError("Admin Access орчны нэр дутуу байна.")

  const fetcher = input.fetcher ?? fetch
  const options = () => ({
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  })
  const organization = await requestCloudflare(
    fetcher,
    `${apiOrigin}/accounts/${encodeURIComponent(accountId)}/access/organizations`,
    options(),
    "Zero Trust organization-ийн MFA-г баталгаажуулах",
  )
  if (!record(organization.result) || !hasRequiredIndependentMfa(organization.result)) {
    throw new CloudflareAccessPreflightError(
      "Cloudflare Zero Trust organization Independent MFA шаардлага хангахгүй байна.",
    )
  }
  const teamDomain = normalizeTeamDomain(String(organization.result.auth_domain))

  const applications = await requestCloudflare(
    fetcher,
    `${apiOrigin}/accounts/${encodeURIComponent(accountId)}/access/apps?domain=${encodeURIComponent(hostname)}&per_page=10`,
    options(),
    "Admin Access application-ийг унших",
  )
  if (!Array.isArray(applications.result)) {
    throw new CloudflareAccessPreflightError("Admin Access application жагсаалтын хариу танигдсан хэлбэртэй биш байна.")
  }
  const matches = applications.result.filter(
    (value): value is Record<string, unknown> => record(value) && value.domain === hostname,
  )
  if (matches.length !== 1) {
    throw new CloudflareAccessPreflightError("Admin hostname-д яг нэг Cloudflare Access application байх ёстой.")
  }
  const application = matches[0]
  inspectAdminApplication(application, hostname, stage)

  const applicationId = typeof application.id === "string" ? application.id.trim() : ""
  if (!/^[0-9a-f-]{32,36}$/i.test(applicationId)) {
    throw new CloudflareAccessPreflightError("Admin Access application ID хүчинтэй биш байна.")
  }
  const policies = await requestCloudflare(
    fetcher,
    `${apiOrigin}/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(applicationId)}/policies?per_page=10`,
    options(),
    "Admin Access policy-г унших",
  )
  if (!Array.isArray(policies.result) || policies.result.length !== 1 || !record(policies.result[0])) {
    throw new CloudflareAccessPreflightError("Admin Access application яг нэг allow policy-тэй байх ёстой.")
  }
  inspectAdminPolicy(policies.result[0], bootstrapEmails)

  return { hostname, teamDomain, bootstrapEmailCount: bootstrapEmails.length }
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
    if (response.status === 403 && operation === "Zero Trust organization-ийг унших") {
      throw new CloudflareAccessPreflightError(
        `${operation} амжилтгүй боллоо (HTTP 403). Cloudflare Dashboard-ийн Zero Trust хэсэгт Zero Trust Free багцыг бүрэн идэвхжүүлсэн эсэх, мөн токены Access-ийн хоёр эрх Edit түвшинтэй эсэхийг шалгана.`,
      )
    }
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

function inspectAdminApplication(application: Record<string, unknown>, hostname: string, stage: string) {
  const checks = [
    ["name", application.name === `MongolGPT админ (${stage})`],
    ["domain", application.domain === hostname],
    ["type", application.type === "self_hosted"],
    ["session_duration", application.session_duration === "4h"],
    ["allow_authenticate_via_warp", application.allow_authenticate_via_warp === false],
    ["allow_iframe", application.allow_iframe === false || !Object.hasOwn(application, "allow_iframe")],
    ["app_launcher_visible", application.app_launcher_visible === false],
    ["enable_binding_cookie", application.enable_binding_cookie === true],
    ["http_only_cookie_attribute", application.http_only_cookie_attribute === true],
    ["options_preflight_bypass", application.options_preflight_bypass === false],
    ["same_site_cookie_attribute", application.same_site_cookie_attribute === "strict"],
    ["aud", typeof application.aud === "string" && Boolean(application.aud.trim())],
    ["mfa_config", hasExactBrowserMfa(application.mfa_config)],
  ] as const
  const failed = checks.filter(([, valid]) => !valid).map(([name]) => name)
  if (failed.length) {
    throw new CloudflareAccessPreflightError(
      `Admin Access application хамгаалалтын тохиргоо шаардлага хангахгүй байна: ${failed.join(", ")}.`,
    )
  }
}

function inspectAdminPolicy(policy: Record<string, unknown>, expectedEmails: string[]) {
  const includes = Array.isArray(policy.include)
    ? policy.include
    : Array.isArray(policy.includes)
      ? policy.includes
      : []
  const emails = includes.flatMap((value) => {
    if (!record(value) || !record(value.email) || typeof value.email.email !== "string") return []
    return [value.email.email.trim().toLowerCase()]
  })
  const excluded = Array.isArray(policy.exclude) ? policy.exclude : []
  const required = Array.isArray(policy.require) ? policy.require : []
  if (
    policy.name !== "MongolGPT администраторууд" ||
    policy.decision !== "allow" ||
    policy.precedence !== 1 ||
    excluded.length ||
    required.length ||
    emails.length !== includes.length ||
    !sameStrings(emails, expectedEmails) ||
    !hasExactBrowserMfa(policy.mfa_config)
  ) {
    throw new CloudflareAccessPreflightError(
      "Admin Access allow policy зөвшөөрөгдсөн имэйл ба MFA шаардлагатай таарахгүй байна.",
    )
  }
}

function hasExactBrowserMfa(value: unknown) {
  if (!record(value) || value.mfa_disabled !== false || value.session_duration !== "1h") return false
  const allowed = Array.isArray(value.allowed_authenticators)
    ? value.allowed_authenticators.filter((item): item is string => typeof item === "string")
    : []
  return sameStrings(allowed, [...cloudflareAccessMfaAuthenticators])
}

function parseBootstrapEmails(value: string) {
  const emails = [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  if (!emails.length || emails.some((email) => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new CloudflareAccessPreflightError("Admin bootstrap имэйлүүд дутуу эсвэл буруу байна.")
  }
  return emails
}

function sameStrings(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const sortedRight = [...right].sort()
  return [...left].sort().every((value, index) => value === sortedRight[index])
}

function normalizeHostname(value: string) {
  const hostname = value.trim().toLowerCase()
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new CloudflareAccessPreflightError("Admin Access hostname хүчинтэй биш байна.")
  }
  return hostname
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
