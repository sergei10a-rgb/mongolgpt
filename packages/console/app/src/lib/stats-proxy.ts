import type { APIEvent } from "@solidjs/start/server"
import { LOCALE_HEADER, cookie, localeFromRequest, route, tag } from "~/lib/language"
import { publicProxyRequestHeaders } from "~/lib/public-proxy-headers"

const dataPath = "/data"

export async function statsProxy(evt: APIEvent) {
  const req = evt.request.clone()
  const locale = localeFromRequest(req)
  const redirect = redirectToLocalizedData(req, new URL(req.url), locale)
  if (redirect) return redirect

  const requestUrl = new URL(req.url)
  if (!isAllowedStatsProxyRequest(req.method, requestUrl.pathname)) return methodNotAllowed()

  const statsUrl = import.meta.env.VITE_MONGOLGPT_STATS_URL?.trim()
  if (!statsUrl) return upstreamUnavailable()

  const targetUrl = requestUrl
  const upstreamUrl = new URL(statsUrl)
  targetUrl.protocol = upstreamUrl.protocol
  targetUrl.hostname = upstreamUrl.hostname
  targetUrl.port = upstreamUrl.port

  if (
    targetUrl.pathname.startsWith(`${dataPath}/_build/`) ||
    targetUrl.pathname === `${dataPath}/banner.jpg` ||
    targetUrl.pathname === `${dataPath}/banner.png`
  ) {
    targetUrl.pathname = targetUrl.pathname.slice(dataPath.length)
  }

  const requestHeaders = publicProxyRequestHeaders(req.headers)
  requestHeaders.set(LOCALE_HEADER, locale)
  requestHeaders.set("accept-language", tag(locale))

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: requestHeaders,
    body: req.body,
  })

  if (!response.headers.get("content-type")?.includes("text/html")) return response

  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.delete("etag")
  appendVary(headers, "Accept-Language", "Cookie")

  return new Response(rewriteStatsHtml(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function statsRedirect(evt: APIEvent) {
  const url = new URL(evt.request.url)
  url.pathname = `${dataPath}${url.pathname.slice("/stats".length)}`
  return new Response(null, {
    status: 308,
    headers: {
      Location: url.toString(),
    },
  })
}

function rewriteStatsHtml(html: string) {
  return html.replaceAll('"/_build/', `"${dataPath}/_build/`).replaceAll("'/_build/", `'${dataPath}/_build/`)
}

function redirectToLocalizedData(request: Request, url: URL, locale: ReturnType<typeof localeFromRequest>) {
  if (locale === "en") return null
  if (request.headers.get(LOCALE_HEADER)) return null
  if (request.method !== "GET" && request.method !== "HEAD") return null
  if (!acceptsHtml(request)) return null
  if (!url.pathname.startsWith(`${dataPath}/`) && url.pathname !== dataPath) return null
  if (isDataBypassPath(url.pathname)) return null

  const next = new URL(url)
  next.pathname = route(locale, url.pathname)

  const headers = new Headers({
    Location: next.toString(),
  })
  headers.append("set-cookie", cookie(locale))
  appendVary(headers, "Accept-Language", "Cookie")

  return new Response(null, {
    status: 308,
    headers,
  })
}

function acceptsHtml(request: Request) {
  const accept = request.headers.get("accept")
  return !accept || accept.includes("text/html") || accept.includes("*/*")
}

function isDataBypassPath(pathname: string) {
  return (
    pathname.startsWith(`${dataPath}/_build/`) ||
    pathname.startsWith(`${dataPath}/api/`) ||
    pathname.startsWith(`${dataPath}/_server`) ||
    pathname === `${dataPath}/banner.jpg` ||
    pathname === `${dataPath}/banner.png`
  )
}

function appendVary(headers: Headers, ...values: string[]) {
  const existing = headers
    .get("vary")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  headers.set(
    "vary",
    values
      .reduce(
        (result, value) =>
          result.some((item) => item.toLowerCase() === value.toLowerCase()) ? result : [...result, value],
        existing ?? [],
      )
      .join(", "),
  )
}

export function isAllowedStatsProxyRequest(method: string, pathname: string) {
  if (method === "GET" || method === "HEAD") return true
  return method === "POST" && pathname === `${dataPath}/api/newsletter`
}

function upstreamUnavailable() {
  return new Response("Статистикийн үйлчилгээний хаяг одоогоор тохируулаагүй байна.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  })
}

function methodNotAllowed() {
  return new Response("Энэ хүсэлтийн аргыг статистикийн үйлчилгээ дэмжихгүй байна.", {
    status: 405,
    headers: {
      allow: "GET, HEAD, POST",
      "content-type": "text/plain; charset=utf-8",
    },
  })
}
