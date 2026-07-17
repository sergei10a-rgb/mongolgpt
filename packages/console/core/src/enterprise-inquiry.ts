import { Resource } from "@mongolgpt/console-resource"
import type { D1Database } from "@cloudflare/workers-types"
import { ulid } from "ulid"
import {
  InvalidNewsletterSubscriptionError,
  normalizeNewsletterEmail,
  normalizeNewsletterLocale,
} from "./newsletter"

export const enterpriseInquiryFormVersion = "enterprise-v1"

export class InvalidEnterpriseInquiryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidEnterpriseInquiryError"
  }
}

function requiredText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidEnterpriseInquiryError(`${label} талбарыг бөглөнө үү.`)
  }
  const result = value.trim()
  if (result.length > maxLength) throw new InvalidEnterpriseInquiryError(`${label} талбар хэт урт байна.`)
  return result
}

function optionalText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") throw new InvalidEnterpriseInquiryError(`${label} талбар буруу байна.`)
  const result = value.trim()
  if (!result) return null
  if (result.length > maxLength) throw new InvalidEnterpriseInquiryError(`${label} талбар хэт урт байна.`)
  return result
}

export async function submitEnterpriseInquiry(
  input: {
    name: unknown
    role: unknown
    company?: unknown
    email: unknown
    phone?: unknown
    message: unknown
    locale?: unknown
  },
  database: D1Database = Resource.Database,
) {
  let email: string
  try {
    email = normalizeNewsletterEmail(input.email)
  } catch (error) {
    if (error instanceof InvalidNewsletterSubscriptionError) {
      throw new InvalidEnterpriseInquiryError("Зөв и-мэйл хаяг оруулна уу.")
    }
    throw error
  }

  const inquiry = {
    id: ulid(),
    name: requiredText(input.name, "Нэр", 120),
    role: requiredText(input.role, "Албан үүрэг", 120),
    company: optionalText(input.company, "Байгууллага", 200),
    email,
    phone: optionalText(input.phone, "Утас", 64),
    message: requiredText(input.message, "Зурвас", 5_000),
    locale: normalizeNewsletterLocale(input.locale),
  }
  const now = Date.now()

  await database
    .prepare(
      `insert into enterprise_inquiry (
        id, name, role, company, email, phone, message, locale, source, status, form_version,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, 'enterprise', 'new', ?, ?, ?)`,
    )
    .bind(
      inquiry.id,
      inquiry.name,
      inquiry.role,
      inquiry.company,
      inquiry.email,
      inquiry.phone,
      inquiry.message,
      inquiry.locale,
      enterpriseInquiryFormVersion,
      now,
      now,
    )
    .run()

  return { id: inquiry.id }
}
