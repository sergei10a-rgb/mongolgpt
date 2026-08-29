import { FreeUsageLimitError } from "./error"
import { logger } from "./logger"
import { buildRateLimitKey, claimResult, ledgerCommand } from "./quota-service"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { Subscription } from "@mongolgpt/console-core/subscription.js"

type FreeLimits = Awaited<ReturnType<typeof Subscription.getFreeLimits>>

export async function createRateLimiter(
  modelId: string,
  rateLimit: number | undefined,
  request: Request,
  freeLimits?: FreeLimits,
) {
  const limits = freeLimits ?? (await Subscription.getFreeLimits())
  const proxyHeadersVerified = hasVerifiedProxyHeaders(request, limits.checkHeaders)
  const locale = proxyHeadersVerified ? localeFromRequest(request) : "mn"
  const dict = i18n(locale)
  const dailyLimit = proxyHeadersVerified ? (rateLimit ?? limits.dailyRequests) : limits.dailyRequestsFallback
  const isDefaultModel = proxyHeadersVerified && !rateLimit

  const ip = clientIpFromRequest(request)
  const now = Date.now()
  const dailyInterval =
    proxyHeadersVerified && rateLimit ? `${buildYYYYMMDD(now)}${modelId.substring(0, 2)}` : buildYYYYMMDD(now)
  const retryAfter = getRetryAfterDay(now)
  const lifetimeKey = buildRateLimitKey("ip", ip)
  const dailyKey = buildRateLimitKey("ip", ip, dailyInterval)

  return {
    check: async () => {
      const result = claimResult(
        await ledgerCommand(`ip:${ip}`, {
          type: "ip-claim",
          dailyKey,
          lifetimeKey: isDefaultModel ? lifetimeKey : null,
          dailyLimit: Math.max(1, Math.ceil(dailyLimit)),
          dailyExpiresAt: now + retryAfter * 1_000,
        }),
      )
      logger.debug(`rate limit lifetime: ${Number(result.lifetime ?? 0)}, daily: ${Number(result.daily ?? 0)}`)
      if (!result.allowed)
        throw new FreeUsageLimitError(
          proxyHeadersVerified
            ? rateLimitMessage(locale, dict["gateway.api.error.rateLimitExceeded"])
            : dict["gateway.api.error.rateLimitExceeded"],
          retryAfter,
        )
    },
    track: async () => undefined,
  }
}

export function getRetryAfterDay(now: number) {
  return Math.ceil((86_400_000 - (now % 86_400_000)) / 1000)
}

function hasVerifiedProxyHeaders(request: Request, checkHeaders: Record<string, string>) {
  const headers = Object.entries(checkHeaders)
  if (!headers.length) return false

  return headers.every(([name, value]) => {
    const actual = request.headers.get(name)
    if (!actual) return false
    return actual === value
  })
}

export function clientIpFromRequest(request: Request) {
  // Cloudflare sets this on direct edge traffic; forwarding headers remain caller-controlled.
  const raw = request.headers.get("cf-connecting-ip")
  if (!raw) return "unknown"

  const value = raw.trim().toLowerCase()
  const ipv4 = normalizeIpv4(value)
  if (ipv4) return ipv4

  return normalizeIpv6Prefix(value) ?? "unknown"
}

function normalizeIpv4(value: string): string | undefined {
  const parts = value.split(".")
  if (parts.length !== 4) return undefined
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return undefined
  return parts.map((part) => String(Number(part))).join(".")
}

function normalizeIpv6Prefix(value: string): string | undefined {
  if (!/^[0-9a-f:]+$/.test(value)) return undefined

  const compressed = value.split("::")
  if (compressed.length > 2) return undefined

  const left = compressed[0] ? compressed[0].split(":") : []
  const right = compressed[1] ? compressed[1].split(":") : []
  const valid = (part: string) => /^[0-9a-f]{1,4}$/.test(part)
  if (!left.every(valid) || !right.every(valid)) return undefined

  const missing = 8 - left.length - right.length
  if (compressed.length === 1 && missing !== 0) return undefined
  if (compressed.length === 2 && missing < 1) return undefined

  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
  if (groups.length !== 8) return undefined
  return groups
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join(":")
}

function rateLimitMessage(locale: string, fallback: string) {
  if (locale !== "mn") return fallback
  return "Хүсэлтийн давтамжийн хязгаарт хүрлээ. Түр хүлээгээд дахин оролдоно уу."
}

function buildYYYYMMDD(timestamp: number) {
  return new Date(timestamp)
    .toISOString()
    .replace(/[^0-9]/g, "")
    .substring(0, 8)
}
