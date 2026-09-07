import type { APIEvent } from "@solidjs/start/server"
import { Resource } from "@mongolgpt/console-resource"
import { listActiveAccountWorkspaces } from "@mongolgpt/console-core/account-overview.js"
import { verifyCliAccount } from "~/lib/cli-auth"
import { hostedRuntimeUrl } from "~/lib/hosted-env"
import { nativeRuntimeTokenRequest } from "./runtime-token-handler"

export async function POST(event: APIEvent) {
  return nativeRuntimeTokenRequest(event.request, {
    runtimeUrl: hostedRuntimeUrl,
    secret: Resource.MongolGPTRuntimeAuthSecret.value,
    authenticate: async (request) => {
      const result = await verifyCliAccount(request)
      if ("response" in result) return undefined
      return { id: result.account.accountID, email: result.account.email, authVersion: result.account.authVersion }
    },
    workspaces: listActiveAccountWorkspaces,
  })
}
