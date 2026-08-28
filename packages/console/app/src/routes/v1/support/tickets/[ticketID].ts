import type { APIEvent } from "@solidjs/start/server"
import { validateAuthSession } from "~/context/auth"
import { verifyCliToken } from "~/lib/cli-auth"
import { hostedAppUrl } from "~/lib/hosted-env"
import { resolveAccountOverviewIdentity } from "../../account/overview-auth"
import { supportPreflight, ticketDetailRequest } from "../support-handler"

export function OPTIONS(event: APIEvent) {
  return supportPreflight(event.request, hostedAppUrl)
}

export function GET(event: APIEvent) {
  return ticketDetailRequest(event.request, ticketID(event.request), {
    appUrl: hostedAppUrl,
    authenticate: (request) =>
      resolveAccountOverviewIdentity(request, { verifyToken: verifyCliToken, session: validateAuthSession }),
  })
}

function ticketID(request: Request) {
  return new URL(request.url).pathname.split("/").at(-1) ?? ""
}
