import { OauthCallbackPage } from "@mongolgpt/core/oauth/page"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { ServerAuth } from "@/server/auth"
import { authorizationRouterMiddleware } from "./middleware/authorization"
import { desktopSmokeProofAccepted, desktopSmokeProofHeader } from "./middleware/account-use"

export const desktopSmokeOauthSuccessPath = "/_internal/desktop-smoke/oauth-callback/success"
export const desktopSmokeOauthErrorPath = "/_internal/desktop-smoke/oauth-callback/error"

export function desktopSmokeOauthCallbackDocument(pathname: string, proof: string | undefined) {
  if (!desktopSmokeProofAccepted(proof)) return undefined
  if (pathname === desktopSmokeOauthSuccessPath) {
    return OauthCallbackPage.success({ provider: "MongolGPT", autoClose: false })
  }
  if (pathname === desktopSmokeOauthErrorPath) {
    return OauthCallbackPage.error("Desktop OAuth callback smoke", { provider: "MongolGPT" })
  }
  return undefined
}

const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))

export const desktopSmokeRoute = HttpRouter.use((router) =>
  router.add("GET", "/_internal/desktop-smoke/oauth-callback/:state", (request) => {
    const pathname = new URL(request.url, "http://localhost").pathname
    const html = desktopSmokeOauthCallbackDocument(pathname, request.headers[desktopSmokeProofHeader])
    if (!html) return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
    return Effect.succeed(
      HttpServerResponse.text(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))
