import type { APIEvent } from "@solidjs/start"
import { validateAuthSession } from "~/context/auth"

export async function GET(_input: APIEvent) {
  const session = await validateAuthSession()
  if (session.suspended && Object.keys(session.data.account ?? {}).length === 0) {
    return Response.json(
      {
        error: "account_suspended",
        message: "MongolGPT аккаунт түр түдгэлзсэн байна.",
      },
      {
        status: 423,
        headers: { "cache-control": "no-store" },
      },
    )
  }
  return Response.json(session.data, {
    headers: { "cache-control": "no-store" },
  })
}
