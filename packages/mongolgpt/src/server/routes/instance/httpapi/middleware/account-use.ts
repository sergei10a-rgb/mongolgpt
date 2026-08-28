import { Account } from "@/account/account"
import { ServerAuth } from "@/server/auth"
import { InstallationChannel } from "@mongolgpt/core/installation/version"
import { Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { serverRequestAuthorized } from "./authorization"

export const AccountLoginRequiredMessage =
  "MongolGPT ашиглахын өмнө mongolgpt account login ажиллуулаад account-аараа нэвтэрч, workspace-аа сонгоно уу. Free Auto үнэ төлбөргүй хэвээр бөгөөд subscription шаардахгүй."

const legacySessionUse = /^\/session\/[^/]+\/(?:init|summarize|message|prompt_async|command|shell)\/?$/
const v2SessionUse = /^\/api\/session\/[^/]+\/(?:agent|model|prompt|compact)\/?$/

export function accountUseRoute(method: string, pathname: string) {
  if (method.toUpperCase() !== "POST") return false
  if (pathname === "/session" || pathname === "/session/") return true
  if (pathname === "/api/session" || pathname === "/api/session/") return true
  return legacySessionUse.test(pathname) || v2SessionUse.test(pathname)
}

export function accountUseAllowed(input: {
  channel?: string
  activeOrgID?: string | null
  hostedRuntime?: boolean
  serverAuthRequired?: boolean
}) {
  if ((input.channel ?? InstallationChannel) === "local") return true
  if (input.hostedRuntime && input.serverAuthRequired) return true
  return Boolean(input.activeOrgID?.trim())
}

export const accountUseRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    if (accountUseAllowed({ channel: InstallationChannel })) return (effect) => effect

    const account = yield* Account.Service
    const serverAuth = yield* ServerAuth.Config
    const hostedRuntime = process.env.MONGOLGPT_RUNTIME_MODE === "hosted"

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const pathname = new URL(request.url, "http://localhost").pathname
        if (!accountUseRoute(request.method, pathname)) return yield* effect

        const serverAuthRequired = ServerAuth.required(serverAuth)
        if (serverAuthRequired && !hostedRuntime && !(yield* serverRequestAuthorized(request, serverAuth))) {
          return yield* effect
        }

        if (
          accountUseAllowed({
            channel: InstallationChannel,
            hostedRuntime,
            serverAuthRequired,
          })
        )
          return yield* effect

        const active = yield* account.active().pipe(Effect.catch(() => Effect.succeed(Option.none())))
        const activeOrgID = Option.isSome(active) ? active.value.active_org_id : undefined
        if (accountUseAllowed({ channel: InstallationChannel, activeOrgID })) return yield* effect

        return HttpServerResponse.jsonUnsafe(
          { _tag: "AccountLoginRequired", message: AccountLoginRequiredMessage },
          { status: 403 },
        )
      })
  }),
)
