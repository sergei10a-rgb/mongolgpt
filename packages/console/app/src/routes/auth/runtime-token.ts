import { Resource } from "@mongolgpt/console-resource"
import { listActiveAccountWorkspaces } from "@mongolgpt/console-core/account-overview.js"
import type { APIEvent } from "@solidjs/start/server"
import { validateAuthSession } from "~/context/auth"
import { hostedAppUrl, hostedRuntimeUrl } from "~/lib/hosted-env"
import { runtimeTokenPreflight, runtimeTokenRequest } from "./runtime-token-handler"

export async function OPTIONS(input: APIEvent) {
  return runtimeTokenPreflight(input.request, hostedAppUrl)
}

export async function POST(input: APIEvent) {
  return runtimeTokenRequest(input.request, {
    appUrl: hostedAppUrl,
    runtimeUrl: hostedRuntimeUrl,
    secret: Resource.MongolGPTRuntimeAuthSecret.value,
    session: validateAuthSession,
    workspaces: listActiveAccountWorkspaces,
  })
}
