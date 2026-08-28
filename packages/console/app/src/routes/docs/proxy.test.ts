import { afterEach, describe, expect, mock, test } from "bun:test"
import type { APIEvent } from "@solidjs/start/server"
import { docsHeadProxyHandler, docsProxyHandler, rewriteDocsHtmlForRootAlias } from "./proxy"

const originalFetch = globalThis.fetch
const originalDocs = import.meta.env.VITE_MONGOLGPT_DOCS_URL
const originalRoot = import.meta.env.VITE_MONGOLGPT_ROOT_URL

function event(url: string, method = "GET") {
  return { request: new Request(url, { method }), params: {} } as APIEvent
}

afterEach(() => {
  globalThis.fetch = originalFetch
  import.meta.env.VITE_MONGOLGPT_DOCS_URL = originalDocs
  import.meta.env.VITE_MONGOLGPT_ROOT_URL = originalRoot
})

describe("docs root alias rewrite", () => {
  test("rewrites docs canonical, og, and support absolute URLs to the public root alias", () => {
    const html = [
      '<link rel="canonical" href="https://docs.dev.mgpt.mn/docs/">',
      '<meta property="og:url" content="https://docs.dev.mgpt.mn/docs/">',
      '<meta property="og:image" content="https://docs.dev.mgpt.mn/docs/social-share.png">',
      '<a href="https://dev.mgpt.mn/support">Тусламж</a>',
    ].join("")

    const result = rewriteDocsHtmlForRootAlias(html, "https://docs.dev.mgpt.mn", "https://mgpt.mn")
    expect(result).toContain('href="https://mgpt.mn/docs/"')
    expect(result).toContain('content="https://mgpt.mn/docs/"')
    expect(result).toContain('content="https://mgpt.mn/docs/social-share.png"')
    expect(result).toContain('href="https://mgpt.mn/support"')
    expect(result).not.toContain("docs.dev.mgpt.mn")
    expect(result).not.toContain("dev.mgpt.mn/support")
  })

  test("leaves canonical dev HTML untouched outside the public root alias", async () => {
    import.meta.env.VITE_MONGOLGPT_DOCS_URL = "https://docs.dev.mgpt.mn"
    import.meta.env.VITE_MONGOLGPT_ROOT_URL = "https://mgpt.mn"
    globalThis.fetch = Object.assign(
      mock(
        async () => new Response('<link rel="canonical" href="https://docs.dev.mgpt.mn/docs/">', { headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
      { preconnect: originalFetch.preconnect },
    )

    const response = await docsProxyHandler(event("https://dev.mgpt.mn/docs/"))
    expect(await response.text()).toContain("https://docs.dev.mgpt.mn/docs/")
  })

  test("rewrites HTML GET responses and refreshes content-length for the root alias", async () => {
    import.meta.env.VITE_MONGOLGPT_DOCS_URL = "https://docs.dev.mgpt.mn"
    import.meta.env.VITE_MONGOLGPT_ROOT_URL = "https://mgpt.mn"
    const html =
      '<link rel="canonical" href="https://docs.dev.mgpt.mn/docs/"><a href="https://dev.mgpt.mn/support">Support</a>'
    globalThis.fetch = Object.assign(
      mock(
        async () =>
          new Response(html, {
            headers: { "content-type": "text/html; charset=utf-8", "content-length": "1", etag: '"dev"' },
          }),
      ),
      { preconnect: originalFetch.preconnect },
    )

    const response = await docsProxyHandler(event("https://mgpt.mn/docs/"))
    const body = await response.text()
    expect(body).toContain("https://mgpt.mn/docs/")
    expect(body).toContain("https://mgpt.mn/support")
    expect(response.headers.get("content-length")).toBe(String(new TextEncoder().encode(body).byteLength))
    expect(response.headers.get("etag")).toBeNull()
  })

  test("keeps non-HTML responses streaming without rewrite", async () => {
    import.meta.env.VITE_MONGOLGPT_DOCS_URL = "https://docs.dev.mgpt.mn"
    import.meta.env.VITE_MONGOLGPT_ROOT_URL = "https://mgpt.mn"
    globalThis.fetch = Object.assign(
      mock(async () => new Response("PNG", { headers: { "content-type": "image/png", "content-length": "3" } })),
      { preconnect: originalFetch.preconnect },
    )

    const response = await docsProxyHandler(event("https://mgpt.mn/docs/logo.png"))
    expect(await response.text()).toBe("PNG")
    expect(response.headers.get("content-length")).toBe("3")
  })

  test("keeps HEAD body empty while publishing rewritten HTML content-length on the root alias", async () => {
    import.meta.env.VITE_MONGOLGPT_DOCS_URL = "https://docs.dev.mgpt.mn"
    import.meta.env.VITE_MONGOLGPT_ROOT_URL = "https://mgpt.mn"
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { "content-type": "text/html; charset=utf-8", "content-length": "10" } })
      }
      return new Response('<meta property="og:url" content="https://docs.dev.mgpt.mn/docs/">', {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    })
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })

    const response = await docsHeadProxyHandler(event("https://mgpt.mn/docs/", "HEAD"))
    expect(await response.text()).toBe("")
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode('<meta property="og:url" content="https://mgpt.mn/docs/">').byteLength),
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
