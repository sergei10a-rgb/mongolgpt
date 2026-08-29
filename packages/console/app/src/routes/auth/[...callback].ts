import type { APIEvent } from "@solidjs/start/server"
import { AuthClient } from "~/context/auth"
import { useAuthSession } from "~/context/auth"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { hostedConsoleUrl } from "~/lib/hosted-env"
import { configuredConsoleRequestUrl } from "./helpers"
import { useOAuthStateSession } from "./oauth-state"
import { completeOAuthCallback } from "./callback-handler"

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
    return await completeOAuthCallback({
      url,
      locale,
      dict,
      authClient: AuthClient,
      authSession: await useAuthSession(),
      oauthStateSession: await useOAuthStateSession(),
    })
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
