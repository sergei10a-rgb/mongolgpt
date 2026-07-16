import type { APIEvent } from "@solidjs/start/server"
import { LOCALE_HEADER, localeFromCookieHeader, parseLocale, tag } from "~/lib/language"

async function handler(evt: APIEvent) {
  const req = evt.request.clone()
  const url = new URL(req.url)
  const enterpriseUrl = import.meta.env.VITE_MONGOLGPT_ENTERPRISE_URL?.trim()
  if (!enterpriseUrl) return upstreamUnavailable()
  const targetUrl = new URL(`/enterprise${url.pathname}${url.search}`, enterpriseUrl)

  const headers = new Headers(req.headers)
  headers.delete("host")
  const locale = parseLocale(req.headers.get(LOCALE_HEADER)) ?? localeFromCookieHeader(req.headers.get("cookie"))
  if (locale) headers.set("accept-language", tag(locale))

  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.body,
  })
  return response
}

function upstreamUnavailable() {
  return new Response("Enterprise үйлчилгээний хаяг одоогоор тохируулаагүй байна.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  })
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
export const OPTIONS = handler
export const PATCH = handler
