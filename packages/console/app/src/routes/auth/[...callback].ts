import { redirect } from "@solidjs/router"
import type { APIEvent } from "@solidjs/start/server"
import { AuthClient } from "~/context/auth"
import { useAuthSession } from "~/context/auth"
import { i18n } from "~/i18n"
import { localeFromRequest, route } from "~/lib/language"
import { hostedConsoleUrl } from "~/lib/hosted-env"
import { authCallbackTarget, configuredConsoleRequestUrl } from "./helpers"

export async function GET(input: APIEvent) {
  const locale = localeFromRequest(input.request)
  const dict = i18n(locale)
  const url = configuredConsoleRequestUrl(input.request.url, hostedConsoleUrl)
  if (!url) {
    return Response.json(
      { error: dict["auth.callback.error.codeMissing"] },
      { status: 400, headers: { "cache-control": "no-store" } },
    )
  }

  try {
    const code = url.searchParams.get("code")
    if (!code) throw new Error(dict["auth.callback.error.codeMissing"])
    const result = await AuthClient.exchange(code, `${url.origin}${url.pathname}`)
    if (result.err) throw new Error(result.err.message)
    const verified = await AuthClient.verify(result.tokens.access)
    if (verified.err) throw new Error(verified.err.message)
    if (verified.subject.type !== "account") throw new Error(dict["auth.callback.error.codeMissing"])
    const session = await useAuthSession()
    const id = verified.subject.properties.accountID
    await session.update((value) => {
      return {
        ...value,
        account: {
          ...value.account,
          [id]: {
            id,
            email: verified.subject.properties.email,
            authVersion: verified.subject.properties.authVersion ?? 0,
          },
        },
        current: id,
        blocked: undefined,
      }
    })
    return redirect(route(locale, authCallbackTarget(url)))
  } catch (error) {
    console.error("MongolGPT OAuth callback дууссангүй", error instanceof Error ? error.name : typeof error)
    return Response.json(
      {
        error: dict["gateway.api.error.internalServer"],
      },
      {
        status: 500,
        headers: { "cache-control": "no-store" },
      },
    )
  }
}
