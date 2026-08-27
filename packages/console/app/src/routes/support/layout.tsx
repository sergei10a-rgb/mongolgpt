import { A, type RouteSectionProps, createAsync, query, redirect } from "@solidjs/router"
import { Show } from "solid-js"
import { getActor } from "~/context/auth"
import { useLanguage } from "~/context/language"
import { UserMenu } from "../user-menu"
import "./support.css"

const requireSupportAccount = query(async () => {
  "use server"
  const actor = await getActor()
  if (actor.type !== "account") throw redirect("/auth/authorize")
  return { email: actor.properties.email }
}, "support.account")

export default function SupportLayout(props: RouteSectionProps) {
  const account = createAsync(() => requireSupportAccount())
  const language = useLanguage()
  return (
    <Show when={account()}>
      {(current) => (
        <div data-page="support-shell">
          <header data-component="support-header">
            <A href={language.route("/")} data-slot="brand">
              MongolGPT
            </A>
            <UserMenu email={current().email} />
          </header>
          {props.children}
        </div>
      )}
    </Show>
  )
}
