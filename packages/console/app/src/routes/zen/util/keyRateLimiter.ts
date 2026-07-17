import { RateLimitError } from "./error"
import { buildRateLimitKey, claimResult, hashIdentifier, ledgerCommand } from "./quota-service"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"

export function createRateLimiter(
  modelId: string,
  rateLimit: number | undefined,
  zenApiKey: string | undefined,
  request: Request,
) {
  if (!zenApiKey) return
  const locale = localeFromRequest(request)
  const dict = i18n(locale)

  const LIMIT = rateLimit ?? 1000
  const yyyyMMddHHmm = new Date(Date.now())
    .toISOString()
    .replace(/[^0-9]/g, "")
    .substring(0, 12)
  const interval = `${modelId.substring(0, 27)}-${yyyyMMddHHmm}`

  return {
    check: async () => {
      const identifier = await hashIdentifier(zenApiKey)
      const key = buildRateLimitKey("key", identifier, interval)
      const result = claimResult(
        await ledgerCommand(`key:${identifier}`, {
          type: "claim",
          key,
          amount: 1,
          limit: Math.max(1, Math.ceil(LIMIT)),
          expiresAt: Date.now() + 60_000,
        }),
      )
      if (!result.allowed)
        throw new RateLimitError(rateLimitMessage(locale, dict["zen.api.error.rateLimitExceeded"]), 60)
    },
    track: async () => undefined,
  }
}

function rateLimitMessage(locale: string, fallback: string) {
  if (locale !== "mn") return fallback
  return "API түлхүүрийн хүсэлтийн хязгаарт хүрлээ. Нэг минут хүлээгээд дахин оролдоно уу."
}
