import type { APIEvent } from "@solidjs/start/server"
import { cookie, docs, localeFromRequest, tag } from "~/lib/language"

async function handler(evt: APIEvent) {
  const req = evt.request.clone()
  const url = new URL(req.url)
  const locale = localeFromRequest(req)
  const docsUrl = import.meta.env.VITE_MONGOLGPT_DOCS_URL?.trim()
  if (!docsUrl) return upstreamUnavailable()
  const upstreamUrl = new URL(docsUrl)
  const targetUrl = new URL(`${docs(locale, url.pathname)}${url.search}`, upstreamUrl)

  const headers = new Headers(req.headers)
  headers.set("accept-language", tag(locale))

  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.body,
  })
  const next = new Response(response.body, response)
  next.headers.append("set-cookie", cookie(locale))
  return next
}

function upstreamUnavailable() {
  return new Response("Баримт бичгийн үйлчилгээний хаяг одоогоор тохируулаагүй байна.", {
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
