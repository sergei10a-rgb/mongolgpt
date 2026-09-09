import type { APIEvent } from "@solidjs/start/server"
import { Account } from "@mongolgpt/console-core/account.js"
import { Resource } from "@mongolgpt/console-resource"
import { handleSupportAccountDeletion } from "~/lib/support-account-deletion"

export async function DELETE(event: APIEvent) {
  return handleSupportAccountDeletion(event.request, {
    secret: Resource.SUPPORT_API_KEY.value,
    requestDeletion: Account.remove,
  })
}
