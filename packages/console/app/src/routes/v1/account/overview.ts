import { getAccountOverview } from "@mongolgpt/console-core/account-overview.js"
import type { APIEvent } from "@solidjs/start/server"
import { validateAuthSession } from "~/context/auth"
import { verifyCliToken } from "~/lib/cli-auth"
import { hostedAppUrl, hostedConsoleUrl, hostedPreview } from "~/lib/hosted-env"
import { readLedgerCounters } from "../../gateway/util/quota-service"
import { resolveAccountOverviewIdentity } from "./overview-auth"
import { accountOverviewPreflight, accountOverviewRequest } from "./overview-handler"

export function OPTIONS(input: APIEvent) {
  return accountOverviewPreflight(input.request, previewRequest(input.request) ? hostedPreview?.origin : hostedAppUrl)
}

export function GET(input: APIEvent) {
  const preview = previewRequest(input.request)
  return accountOverviewRequest(input.request, {
    appUrl: preview ? hostedPreview?.origin : hostedAppUrl,
    authenticate: async (request) => {
      const identity = await resolveAccountOverviewIdentity(request, {
        verifyToken: verifyCliToken,
        session: validateAuthSession,
      })
      if (preview && identity.status === "authenticated" && identity.account.email !== hostedPreview?.ownerEmail)
        return { status: "unauthorized" }
      return identity
    },
    load: (request) =>
      getAccountOverview(request, {
        readPlanQuota: ({ scope, keys }) => readLedgerCounters(scope, keys),
      }),
  })
}

function previewRequest(request: Request) {
  return Boolean(
    hostedPreview &&
      new URL(request.url).origin === hostedConsoleUrl &&
      request.headers.get("Origin") === hostedPreview.origin,
  )
}
