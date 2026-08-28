import type { APIEvent } from "@solidjs/start/server"
import { validateAuthSession } from "~/context/auth"
import { verifyCliToken } from "~/lib/cli-auth"
import { hostedAppUrl } from "~/lib/hosted-env"
import { resolveAccountOverviewIdentity } from "../../../account/overview-auth"
import { replyTicketRequest, supportPreflight } from "../../support-handler"

export function OPTIONS(event: APIEvent) {
  return supportPreflight(event.request, hostedAppUrl)
}

export function POST(event: APIEvent) {
  return replyTicketRequest(event.request, ticketID(event.request), {
    appUrl: hostedAppUrl,
    authenticate: (request) =>
      resolveAccountOverviewIdentity(request, { verifyToken: verifyCliToken, session: validateAuthSession }),
  })
}

function ticketID(request: Request) {
  const parts = new URL(request.url).pathname.split("/")
  return parts.at(-2) ?? ""
}
