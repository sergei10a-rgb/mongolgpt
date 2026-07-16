import { redirect } from "@solidjs/router"
import { config } from "~/config"

export async function GET() {
  return redirect(config.social.discord)
}
