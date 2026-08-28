import type { APIEvent } from "@solidjs/start/server"
import { validateAuthSession } from "~/context/auth"
import { verifyCliToken } from "~/lib/cli-auth"
import { hostedAppUrl } from "~/lib/hosted-env"
import { resolveAccountOverviewIdentity } from "../account/overview-auth"
import { createTicketRequest, listTicketsRequest, supportPreflight } from "./support-handler"

const input = () => ({
  appUrl: hostedAppUrl,
  authenticate: (request: Request) =>
    resolveAccountOverviewIdentity(request, { verifyToken: verifyCliToken, session: validateAuthSession }),
})

export function OPTIONS(event: APIEvent) {
  return supportPreflight(event.request, hostedAppUrl)
}

export function GET(event: APIEvent) {
  return listTicketsRequest(event.request, input())
}

export function POST(event: APIEvent) {
  return createTicketRequest(event.request, input())
}
