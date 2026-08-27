import type { APIEvent } from "@solidjs/start/server"
import { Resource } from "@mongolgpt/console-resource"
import { verifyCliToken } from "~/lib/cli-auth"
import { refreshCliToken } from "./token-handler"

export async function POST(event: APIEvent) {
  return refreshCliToken(event.request, {
    tokenEndpoint: `${Resource.AUTH_API_URL.value}/token`,
    verifyToken: verifyCliToken,
  })
}
