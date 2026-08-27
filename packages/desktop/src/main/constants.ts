import { resolveHostedServiceUrls } from "@mongolgpt/account-contract/service-urls"
import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.VITE_MONGOLGPT_CHANNEL ?? import.meta.env.MONGOLGPT_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"
const hostedServices = resolveHostedServiceUrls("mgpt.mn", CHANNEL === "prod" ? "production" : "dev")

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
export const ACCOUNT_SERVER_URL = process.env.MONGOLGPT_CONSOLE_URL?.trim() || hostedServices.console
export const WEB_APP_ORIGIN =
  process.env.MONGOLGPT_APP_ORIGIN?.trim() || process.env.MONGOLGPT_APP_URL?.trim() || hostedServices.app
