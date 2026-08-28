import { getAccountOverview } from "@mongolgpt/console-core/account-overview.js"
import type { APIEvent } from "@solidjs/start/server"
import { validateAuthSession } from "~/context/auth"
import { verifyCliToken } from "~/lib/cli-auth"
import { hostedAppUrl } from "~/lib/hosted-env"
import { readLedgerCounters } from "../../gateway/util/quota-service"
import { resolveAccountOverviewIdentity } from "./overview-auth"
import { accountOverviewPreflight, accountOverviewRequest } from "./overview-handler"

export function OPTIONS(input: APIEvent) {
  return accountOverviewPreflight(input.request, hostedAppUrl)
}

export function GET(input: APIEvent) {
  return accountOverviewRequest(input.request, {
    appUrl: hostedAppUrl,
    authenticate: (request) =>
      resolveAccountOverviewIdentity(request, {
        verifyToken: verifyCliToken,
        session: validateAuthSession,
      }),
    load: (request) =>
      getAccountOverview(request, {
        readPlanQuota: ({ scope, keys }) => readLedgerCounters(scope, keys),
      }),
  })
}
