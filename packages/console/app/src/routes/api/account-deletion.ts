import type { APIEvent } from "@solidjs/start"
import {
  cancelAccountDeletion,
  getAccountDeletion,
  requestAccountDeletion,
} from "@mongolgpt/console-core/account-deletion.js"
import { validateAuthSession } from "~/context/auth"
import { handleAccountDeletion } from "~/lib/account-deletion-api"

async function handle(event: APIEvent) {
  const session = await validateAuthSession()
  const current = session.data.account?.[session.data.current ?? ""]
  return handleAccountDeletion({
    request: event.request,
    identity: current ? { accountID: current.id, email: current.email } : undefined,
    service: { getAccountDeletion, requestAccountDeletion, cancelAccountDeletion },
  })
}

export const GET = handle
export const POST = handle
export const DELETE = handle
