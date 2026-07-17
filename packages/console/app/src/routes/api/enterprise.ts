import type { APIEvent } from "@solidjs/start/server"
import {
  InvalidEnterpriseInquiryError,
  submitEnterpriseInquiry,
} from "@mongolgpt/console-core/enterprise-inquiry.js"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"

const responseHeaders = { "Cache-Control": "no-store" }

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: responseHeaders })
}

export async function POST(event: APIEvent) {
  const locale = localeFromRequest(event.request)
  const dict = i18n(locale)
  const contentLength = Number(event.request.headers.get("content-length") ?? 0)
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return json({ error: "Илгээсэн мэдээлэл хэт их байна." }, 413)
  }

  try {
    const parsed = await event.request.json()
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: dict["enterprise.form.error.allFieldsRequired"] }, 400)
    }
    const body = parsed as Record<string, unknown>
    const trap = typeof body.alias === "string" ? body.alias.trim() : ""
    if (trap) return json({ success: true, message: dict["enterprise.form.success.submitted"] })

    await submitEnterpriseInquiry({
      name: body.name,
      role: body.role,
      company: body.company,
      email: body.email,
      phone: body.phone,
      message: body.message,
      locale,
    })

    return json({ success: true, message: dict["enterprise.form.success.submitted"] })
  } catch (error) {
    if (error instanceof InvalidEnterpriseInquiryError) return json({ error: error.message }, 400)
    if (error instanceof SyntaxError) return json({ error: dict["enterprise.form.error.allFieldsRequired"] }, 400)
    console.error("Enterprise inquiry persistence failed", error instanceof Error ? error.name : typeof error)
    return json({ error: dict["enterprise.form.error.internalServer"] }, 500)
  }
}
