import { createMiddleware } from "@solidjs/start/middleware"
import { hostedConsoleUrl, hostedRootUrl } from "~/lib/hosted-env"
import { LOCALE_HEADER, cookie, fromPathname, strip } from "~/lib/language"
import { previewAuthRedirect, previewWwwRedirect } from "~/lib/preview-alias"

export default createMiddleware({
  onRequest(event) {
    const wwwRedirect = previewWwwRedirect(event.request.url, hostedRootUrl)
    if (wwwRedirect) return Response.redirect(wwwRedirect, 308)

    const authRedirect = previewAuthRedirect(event.request.url, hostedConsoleUrl, hostedRootUrl)
    if (authRedirect) return Response.redirect(authRedirect, 307)

    const url = new URL(event.request.url)
    const locale = fromPathname(url.pathname)
    if (locale) {
      url.pathname = strip(url.pathname)
      const request = new Request(url, event.request)
      request.headers.set(LOCALE_HEADER, locale)
      event.request = request
      event.response.headers.append("set-cookie", cookie(locale))
    }
    return undefined
  },
})
