import { createRemoteJWKSet, jwtVerify } from "jose"
import type { JWTVerifyGetKey } from "jose"
import { normalizePlatformAdminEmail } from "@mongolgpt/console-core/platform-admin.js"
import { Resource } from "@mongolgpt/console-resource"

export interface AdminAccessConfig {
  teamDomain: string
  audience: string
  bootstrapEmails: ReadonlySet<string>
}

export interface CloudflareAccessIdentity {
  email: string
  subject: string
  expiresAt: number
}

export class AdminAccessConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AdminAccessConfigurationError"
  }
}

export class AdminAccessVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AdminAccessVerificationError"
  }
}

const remoteKeyResolvers = new Map<string, JWTVerifyGetKey>()

export function loadAdminAccessConfig() {
  return parseAdminAccessConfig({
    teamDomain: readSecret("MongolGPTAdminAccessTeamDomain"),
    audience: readSecret("MongolGPTAdminAccessAudience"),
    bootstrapEmails: readSecret("MongolGPTAdminBootstrapEmails"),
  })
}

export function parseAdminAccessConfig(input: {
  teamDomain: unknown
  audience: unknown
  bootstrapEmails: unknown
}): AdminAccessConfig {
  const teamDomain = requireText(input.teamDomain, "Cloudflare Access team domain")
  const audience = requireText(input.audience, "Cloudflare Access audience")
  const bootstrap = requireText(input.bootstrapEmails, "анхны админы имэйл")
  const url = parseTeamDomain(teamDomain)

  if (/\s/.test(audience)) {
    throw new AdminAccessConfigurationError("Cloudflare Access audience дотор хоосон зай байж болохгүй.")
  }

  const bootstrapEmails = new Set(
    bootstrap
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((email) => {
        try {
          return normalizePlatformAdminEmail(email)
        } catch {
          throw new AdminAccessConfigurationError("Анхны админы имэйл хаяг буруу байна.")
        }
      }),
  )
  if (bootstrapEmails.size === 0) {
    throw new AdminAccessConfigurationError("Дор хаяж нэг анхны админы имэйл шаардлагатай.")
  }

  return {
    teamDomain: url.origin,
    audience,
    bootstrapEmails,
  }
}

export async function verifyCloudflareAccessAssertion(
  assertion: string,
  config: AdminAccessConfig,
  keyResolver?: JWTVerifyGetKey,
): Promise<CloudflareAccessIdentity> {
  const token = assertion.trim()
  if (!token || token.length > 16_384) {
    throw new AdminAccessVerificationError("Cloudflare Access баталгаажуулалт олдсонгүй.")
  }

  try {
    const result = await jwtVerify(
      token,
      keyResolver ?? remoteKeyResolver(config.teamDomain),
      {
        algorithms: ["RS256"],
        audience: config.audience,
        issuer: config.teamDomain,
        clockTolerance: 5,
      },
    )
    if (result.protectedHeader.alg !== "RS256") {
      throw new AdminAccessVerificationError("Cloudflare Access гарын үсгийн алгоритм буруу байна.")
    }
    if (typeof result.payload.exp !== "number" || typeof result.payload.iat !== "number") {
      throw new AdminAccessVerificationError("Cloudflare Access токены хугацаа дутуу байна.")
    }
    if (
      result.payload.iat > Math.floor(Date.now() / 1000) + 5 ||
      result.payload.exp <= result.payload.iat
    ) {
      throw new AdminAccessVerificationError("Cloudflare Access токены хугацаа буруу байна.")
    }
    if (
      typeof result.payload.sub !== "string" ||
      !result.payload.sub.trim() ||
      result.payload.sub.length > 255
    ) {
      throw new AdminAccessVerificationError("Cloudflare Access хэрэглэгчийн таних утга дутуу байна.")
    }
    if (typeof result.payload.email !== "string") {
      throw new AdminAccessVerificationError("Cloudflare Access имэйл баталгаажаагүй байна.")
    }

    return {
      email: normalizePlatformAdminEmail(result.payload.email),
      subject: result.payload.sub,
      expiresAt: result.payload.exp,
    }
  } catch (error) {
    if (error instanceof AdminAccessVerificationError) throw error
    throw new AdminAccessVerificationError("Cloudflare Access баталгаажуулалт хүчингүй байна.")
  }
}

function remoteKeyResolver(teamDomain: string) {
  const existing = remoteKeyResolvers.get(teamDomain)
  if (existing) return existing
  const resolver = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain))
  remoteKeyResolvers.set(teamDomain, resolver)
  return resolver
}

function readSecret(name: string) {
  try {
    const resource: unknown = Resource[name]
    if (typeof resource === "string") return resource
    if (typeof resource === "object" && resource !== null && "value" in resource) {
      return resource.value
    }
  } catch {
    throw new AdminAccessConfigurationError(`${name} нууц тохиргоо холбогдоогүй байна.`)
  }
  throw new AdminAccessConfigurationError(`${name} нууц тохиргоо хоосон байна.`)
}

function requireText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AdminAccessConfigurationError(`${name} тохиргоо хоосон байна.`)
  }
  return value.trim()
}

function parseTeamDomain(value: string) {
  try {
    const url = new URL(value)
    const exactOrigin = value === url.origin || value === `${url.origin}/`
    const cloudflareTeam =
      url.hostname.endsWith(".cloudflareaccess.com") && url.hostname !== "cloudflareaccess.com"
    if (
      url.protocol !== "https:" ||
      !cloudflareTeam ||
      !exactOrigin ||
      url.username ||
      url.password ||
      url.port
    ) {
      throw new Error("invalid origin")
    }
    return url
  } catch {
    throw new AdminAccessConfigurationError(
      "Cloudflare Access team domain нь https://<team>.cloudflareaccess.com хэлбэртэй байна.",
    )
  }
}
