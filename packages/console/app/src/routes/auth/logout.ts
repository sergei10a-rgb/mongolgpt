import { redirect } from "@solidjs/router"
import { APIEvent } from "@solidjs/start"
import { useAuthSession } from "~/context/auth"

export async function GET(event: APIEvent) {
  const auth = await useAuthSession()
  const current = auth.data.current
  await auth.update((val) => {
    if (current) {
      delete val.account?.[current]
    }
    val.current = Object.keys(val.account ?? {})[0]
    val.blocked = undefined
    event.locals.actor = undefined
    return val
  })
  return redirect("/pricing")
}
