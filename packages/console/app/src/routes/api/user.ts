import type { APIEvent } from "@solidjs/start/server"
import { verifyCliAccount } from "~/lib/cli-auth"

export async function GET(event: APIEvent) {
  const result = await verifyCliAccount(event.request)
  if ("response" in result) return result.response

  return Response.json({
    id: result.account.accountID,
    email: result.account.email,
  })
}
