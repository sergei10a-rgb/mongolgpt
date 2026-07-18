import { redirect } from "@solidjs/router"
import type { APIEvent } from "@solidjs/start/server"
import { AuthClient } from "~/context/auth"
import { useAuthSession } from "~/context/auth"
import { i18n } from "~/i18n"
import { localeFromRequest, route } from "~/lib/language"
import { authCallbackTarget } from "./helpers"

export async function GET(input: APIEvent) {
  const url = new URL(input.request.url)
  const locale = localeFromRequest(input.request)
  const dict = i18n(locale)

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
          },
        },
        current: id,
      }
    })
    return redirect(route(locale, authCallbackTarget(url)))
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : dict["auth.callback.error.codeMissing"],
      },
      {
        status: 500,
        headers: { "cache-control": "no-store" },
      },
    )
  }
}
