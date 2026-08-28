import type { APIEvent } from "@solidjs/start/server"
import { cookie, docs, localeFromRequest, tag } from "~/lib/language"
import { canonicalHttpsOrigin } from "../auth/helpers"

export async function docsProxyHandler(evt: APIEvent) {
  const req = evt.request.clone()
  const url = new URL(req.url)
  const locale = localeFromRequest(req)
  const docsUrl = import.meta.env.VITE_MONGOLGPT_DOCS_URL?.trim()
  if (!docsUrl) return upstreamUnavailable()

  const upstreamUrl = new URL(docsUrl)
  const targetUrl = new URL(`${docs(locale, url.pathname)}${url.search}`, upstreamUrl)
  const headers = new Headers(req.headers)
  headers.set("accept-language", tag(locale))

  const rootUrl = import.meta.env.VITE_MONGOLGPT_ROOT_URL
  const rewrite = shouldRewriteRootAliasHtml(req.url, docsUrl, rootUrl)
  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.body,
  })

  const next = rewrite ? await rewriteDocsProxyResponse(req, response, docsUrl, rootUrl ?? "") : new Response(response.body, response)
  next.headers.append("set-cookie", cookie(locale))
  return next
}

export async function docsHeadProxyHandler(evt: APIEvent) {
  const req = evt.request
  const docsUrl = import.meta.env.VITE_MONGOLGPT_DOCS_URL?.trim()
  const rootUrl = import.meta.env.VITE_MONGOLGPT_ROOT_URL
  if (!docsUrl) return upstreamUnavailable()
  if (!shouldRewriteRootAliasHtml(req.url, docsUrl, rootUrl)) return docsProxyHandler(evt)

  const url = new URL(req.url)
  const locale = localeFromRequest(req)
  const upstreamUrl = new URL(docsUrl)
  const targetUrl = new URL(`${docs(locale, url.pathname)}${url.search}`, upstreamUrl)
  const headers = new Headers(req.headers)
  headers.set("accept-language", tag(locale))

  const head = await fetch(targetUrl, {
    method: "HEAD",
    headers,
  })
  const contentType = head.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("text/html")) {
    const next = new Response(null, head)
    next.headers.append("set-cookie", cookie(locale))
    return next
  }

  const getResponse = await fetch(targetUrl, {
    method: "GET",
    headers,
  })
  const next = await rewriteDocsProxyResponse(new Request(req.url, { method: "HEAD" }), getResponse, docsUrl, rootUrl ?? "")
  next.headers.append("set-cookie", cookie(locale))
  return next
}

export function rewriteDocsHtmlForRootAlias(html: string, docsUrl: string, rootUrl: string) {
  const docsOrigin = canonicalHttpsOrigin(docsUrl)
  const rootOrigin = canonicalHttpsOrigin(rootUrl)
  if (!docsOrigin || !rootOrigin) return html

  let next = html.replaceAll(docsOrigin, rootOrigin)
  const consoleOrigin = consoleOriginFromDocsOrigin(docsOrigin)
  if (consoleOrigin) next = next.replaceAll(`${consoleOrigin}/support`, `${rootOrigin}/support`)
  return next
}

async function rewriteDocsProxyResponse(request: Request, response: Response, docsUrl: string, rootUrl: string) {
  const headers = new Headers(response.headers)
  const contentType = headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("text/html")) {
    return new Response(response.body, { status: response.status, headers })
  }

  const rewritten = rewriteDocsHtmlForRootAlias(await response.text(), docsUrl, rootUrl)
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.delete("etag")
  headers.set("content-length", String(new TextEncoder().encode(rewritten).byteLength))

  if (request.method === "HEAD") return new Response(null, { status: response.status, headers })
  return new Response(rewritten, { status: response.status, headers })
}

function shouldRewriteRootAliasHtml(requestUrl: string, docsUrl: string, rootUrl: string | undefined) {
  const requestOrigin = requestUrlOrigin(requestUrl)
  const docsOrigin = canonicalHttpsOrigin(docsUrl)
  const rootOrigin = canonicalHttpsOrigin(rootUrl)
  return Boolean(requestOrigin && docsOrigin && rootOrigin && requestOrigin === rootOrigin && docsOrigin !== rootOrigin)
}

function requestUrlOrigin(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function consoleOriginFromDocsOrigin(docsOrigin: string) {
  try {
    const url = new URL(docsOrigin)
    if (!url.hostname.startsWith("docs.")) return undefined
    return `https://${url.hostname.slice("docs.".length)}`
  } catch {
    return undefined
  }
}

function upstreamUnavailable() {
  return new Response("Баримт бичгийн үйлчилгээний хаяг одоогоор тохируулаагүй байна.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  })
}
