import type { APIEvent } from "@solidjs/start/server"
import { validateAuthSession } from "~/context/auth"
import { verifyCliToken } from "~/lib/cli-auth"
import { resolveAccountOverviewIdentity } from "../account/overview-auth"
import { createTicketRequest, listTicketsRequest, supportPreflight } from "./support-handler"

const input = () => ({
  appUrl: import.meta.env.MONGOLGPT_APP_URL,
  authenticate: (request: Request) =>
    resolveAccountOverviewIdentity(request, { verifyToken: verifyCliToken, session: validateAuthSession }),
})

export function OPTIONS(event: APIEvent) {
  return supportPreflight(event.request, import.meta.env.MONGOLGPT_APP_URL)
}

export function GET(event: APIEvent) {
  return listTicketsRequest(event.request, input())
}

export function POST(event: APIEvent) {
  return createTicketRequest(event.request, input())
}
