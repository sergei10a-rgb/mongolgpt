import { getAccountOverview } from "@mongolgpt/console-core/account-overview.js"
import type { APIEvent } from "@solidjs/start/server"
import { validateAuthSession } from "~/context/auth"
import { verifyCliToken } from "~/lib/cli-auth"
import { readLedgerCounters } from "../../zen/util/quota-service"
import { resolveAccountOverviewIdentity } from "./overview-auth"
import { accountOverviewPreflight, accountOverviewRequest } from "./overview-handler"

export function OPTIONS(input: APIEvent) {
  return accountOverviewPreflight(input.request, import.meta.env.MONGOLGPT_APP_URL)
}

export function GET(input: APIEvent) {
  return accountOverviewRequest(input.request, {
    appUrl: import.meta.env.MONGOLGPT_APP_URL,
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
