import { redirect } from "@solidjs/router"
import type { APIEvent } from "@solidjs/start/server"
import { getLastSeenWorkspaceID } from "../workspace/common"
import { localeFromRequest, route } from "~/lib/language"
import { getActor } from "~/context/auth"

export async function GET(input: APIEvent) {
  const locale = localeFromRequest(input.request)
  const actor = await getActor()
  if (actor.type !== "account") return redirect("/auth/authorize")
  const workspaceID = await getLastSeenWorkspaceID()
  if (!workspaceID) return redirect(route(locale, "/workspace-picker"))
  return redirect(route(locale, `/workspace/${workspaceID}`))
}
