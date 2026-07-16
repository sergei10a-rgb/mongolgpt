import type { APIEvent } from "@solidjs/start/server"

const shareID = /^[a-zA-Z0-9_-]+$/

export function legacyShareTarget(id: string, shareBaseUrl: string): string | null {
  if (!shareID.test(id)) return null

  try {
    const base = new URL(shareBaseUrl)
    if (base.protocol !== "https:" && base.protocol !== "http:") return null
    return new URL(`/share/${id}`, base).toString()
  } catch {
    return null
  }
}

function handler(evt: APIEvent) {
  const shareBaseUrl = import.meta.env.VITE_MONGOLGPT_ENTERPRISE_URL?.trim()
  if (!shareBaseUrl) return upstreamUnavailable()

  const path = new URL(evt.request.url).pathname
  const id = path.match(/^\/s\/([a-zA-Z0-9_-]+)\/?$/)?.[1]
  const target = id ? legacyShareTarget(id, shareBaseUrl) : null
  if (!target) return new Response("Хуваалцах холбоос буруу байна.", { status: 400 })
  return Response.redirect(target, 308)
}

function upstreamUnavailable() {
  return new Response("Хуваалцах үйлчилгээний хаяг одоогоор тохируулаагүй байна.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  })
}

export const GET = handler
export const HEAD = handler
