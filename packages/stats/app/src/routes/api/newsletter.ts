import {
  InvalidNewsletterSubscriptionError,
  subscribeNewsletter,
} from "@mongolgpt/console-core/newsletter.js"

const responseHeaders = { "Cache-Control": "no-store" }

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: responseHeaders })
}

export async function POST(event: { request: Request }) {
  const contentType = event.request.headers.get("content-type") ?? ""
  if (!contentType.includes("multipart/form-data") && !contentType.includes("application/x-www-form-urlencoded")) {
    return json({ error: "И-мэйл хаягаа маягтаар илгээнэ үү." }, 400)
  }

  const contentLength = Number(event.request.headers.get("content-length") ?? 0)
  if (Number.isFinite(contentLength) && contentLength > 8_192) {
    return json({ error: "Илгээсэн мэдээлэл хэт их байна." }, 413)
  }

  try {
    const form = await event.request.formData()
    await subscribeNewsletter({ email: form.get("email"), locale: form.get("locale"), source: "stats" })
    return json({ success: true })
  } catch (error) {
    if (error instanceof InvalidNewsletterSubscriptionError) return json({ error: error.message }, 400)
    console.error("Newsletter subscription failed", error instanceof Error ? error.name : typeof error)
    return json({ error: "Түр алдаа гарлаа. Дараа дахин оролдоно уу." }, 503)
  }
}
