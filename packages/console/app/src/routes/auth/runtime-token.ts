import { Resource } from "@mongolgpt/console-resource"
import type { APIEvent } from "@solidjs/start/server"
import { validateAuthSession } from "~/context/auth"
import { runtimeTokenPreflight, runtimeTokenRequest } from "./runtime-token-handler"

export async function OPTIONS(input: APIEvent) {
  return runtimeTokenPreflight(input.request, import.meta.env.MONGOLGPT_APP_URL)
}

export async function POST(input: APIEvent) {
  return runtimeTokenRequest(input.request, {
    appUrl: import.meta.env.MONGOLGPT_APP_URL,
    runtimeUrl: import.meta.env.MONGOLGPT_RUNTIME_URL,
    secret: Resource.MongolGPTRuntimeAuthSecret.value,
    session: validateAuthSession,
  })
}
