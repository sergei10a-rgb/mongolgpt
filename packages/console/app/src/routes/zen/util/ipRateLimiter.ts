import { FreeUsageLimitError } from "./error"
import { logger } from "./logger"
import { buildRateLimitKey, getRedis } from "./redis"
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
  const dailyInterval = proxyHeadersVerified && rateLimit ? `${buildYYYYMMDD(now)}${modelId.substring(0, 2)}` : buildYYYYMMDD(now)
  const retryAfter = getRetryAfterDay(now)
  const redis = getRedis()
  const lifetimeKey = buildRateLimitKey("ip", ip)
  const dailyKey = buildRateLimitKey("ip", ip, dailyInterval)
  let isNew = false

  return {
    check: async () => {
      const counts = await redis.mget<(string | number | null)[]>(isDefaultModel ? [lifetimeKey, dailyKey] : [dailyKey])
      const lifetimeCount = isDefaultModel ? Number(counts[0] ?? 0) : 0
      const dailyCount = Number(counts[isDefaultModel ? 1 : 0] ?? 0)
      logger.debug(`rate limit lifetime: ${lifetimeCount}, daily: ${dailyCount}`)

      isNew = isDefaultModel && lifetimeCount < dailyLimit * 7

      if ((isNew && dailyCount >= dailyLimit * 2) || (!isNew && dailyCount >= dailyLimit))
        throw new FreeUsageLimitError(rateLimitMessage(locale, dict["zen.api.error.rateLimitExceeded"]), retryAfter)
    },
    track: async () => {
      const pipeline = redis.pipeline()
      pipeline.incr(dailyKey)
      pipeline.expire(dailyKey, retryAfter)
      if (isNew) pipeline.incr(lifetimeKey)
      await pipeline.exec()
    },
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
