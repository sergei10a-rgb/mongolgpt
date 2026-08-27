import { Navigate } from "@solidjs/router"
import { useLanguage } from "~/context/language"

export default function GatewayRedirect() {
  const language = useLanguage()
  return <Navigate href={language.route("/pricing")} />
}
