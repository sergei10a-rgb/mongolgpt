import { Resource } from "@mongolgpt/console-resource"
import type { D1Database } from "@cloudflare/workers-types"

export const newsletterConsentVersion = "newsletter-v1"

export class InvalidNewsletterSubscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidNewsletterSubscriptionError"
  }
}

export function normalizeNewsletterEmail(value: unknown) {
  if (typeof value !== "string") throw new InvalidNewsletterSubscriptionError("И-мэйл хаягаа оруулна уу.")

  const email = value.trim().toLowerCase()
  const parts = email.split("@")
  const local = parts[0] ?? ""
  const domain = parts[1] ?? ""
  const domainLabels = domain.split(".")
  if (
    email.length < 3 ||
    email.length > 254 ||
    parts.length !== 2 ||
    local.length === 0 ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domainLabels.length < 2 ||
    domainLabels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /\s/.test(email)
  ) {
    throw new InvalidNewsletterSubscriptionError("Зөв и-мэйл хаяг оруулна уу.")
  }
  return email
}

export function normalizeNewsletterLocale(value: unknown) {
  if (typeof value !== "string") return "mn"
  const locale = value.trim().toLowerCase()
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(locale) ? locale : "mn"
}

export async function subscribeNewsletter(
  input: { email: unknown; locale?: unknown; source: "console" | "stats" },
  database: D1Database = Resource.Database,
) {
  const email = normalizeNewsletterEmail(input.email)
  const locale = normalizeNewsletterLocale(input.locale)
  const now = Date.now()

  await database
    .prepare(
      `insert into newsletter_subscriber (
        email, locale, source, status, consent_version, time_consented, time_created, time_updated
      ) values (?, ?, ?, 'active', ?, ?, ?, ?)
      on conflict(email) do update set
        locale = excluded.locale,
        source = excluded.source,
        status = 'active',
        consent_version = excluded.consent_version,
        time_consented = excluded.time_consented,
        time_updated = excluded.time_updated,
        time_deleted = null,
        time_unsubscribed = null`,
    )
    .bind(email, locale, input.source, newsletterConsentVersion, now, now, now)
    .run()

  return { email, locale }
}
