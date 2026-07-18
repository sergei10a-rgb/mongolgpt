import { redirect } from "@solidjs/router"
import type { APIEvent } from "@solidjs/start/server"
import { useAuthSession } from "~/context/auth"
import { configuredAppUrl } from "./helpers"

export async function GET(_input: APIEvent) {
  const appUrl = configuredAppUrl(import.meta.env.MONGOLGPT_APP_URL)
  if (!appUrl) return Response.json({ error: "MONGOLGPT_APP_URL is not configured" }, { status: 500 })

  const session = await useAuthSession()
  if (Object.keys(session.data.account ?? {}).length === 0) {
    return redirect("/auth/authorize?continue=/auth/app")
  }

  return Response.redirect(appUrl.toString(), 302)
}
