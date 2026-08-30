import { redirect } from "@solidjs/router"
import type { APIEvent } from "@solidjs/start/server"
import { getLastSeenWorkspaceID } from "../workspace/common"
import { localeFromRequest, route } from "~/lib/language"
import { getActor } from "~/context/auth"
import { authorizationRoute, workspacePlanRoute } from "~/lib/billing-route"

export async function GET(input: APIEvent) {
  const locale = localeFromRequest(input.request)
  const plan = new URL(input.request.url).searchParams.get("plan")
  const actor = await getActor()
  if (actor.type !== "account") return redirect(authorizationRoute(plan))
  const workspaceID = await getLastSeenWorkspaceID()
  return redirect(route(locale, workspacePlanRoute(workspaceID, plan)))
}
