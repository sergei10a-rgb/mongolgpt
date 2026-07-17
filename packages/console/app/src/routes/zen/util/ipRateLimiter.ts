import { FreeUsageLimitError } from "./error"
import { logger } from "./logger"
import { buildRateLimitKey, claimResult, ledgerCommand } from "./quota-service"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { Subscription } from "@mongolgpt/console-core/subscription.js"

export function createRateLimiter(modelId: string, rateLimit: number | undefined, rawIp: string, request: Request) {
  const locale = localeFromRequest(request)
  const dict = i18n(locale)

  const limits = Subscription.getFreeLimits()
  const proxyHeadersVerified = hasVerifiedProxyHeaders(request, limits.checkHeaders)
  const dailyLimit = proxyHeadersVerified ? (rateLimit ?? limits.dailyRequests) : limits.dailyRequestsFallback
  const isDefaultModel = proxyHeadersVerified && !rateLimit

  const ip = normalizeIdentifier(rawIp)
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
        throw new FreeUsageLimitError(rateLimitMessage(locale, dict["zen.api.error.rateLimitExceeded"]), retryAfter)
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
    return actual.toLowerCase().includes(value.toLowerCase())
  })
}

function normalizeIdentifier(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return "unknown"
  return trimmed
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
