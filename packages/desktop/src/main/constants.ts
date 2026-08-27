import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.VITE_MONGOLGPT_CHANNEL ?? import.meta.env.MONGOLGPT_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
export const ACCOUNT_SERVER_URL =
  process.env.MONGOLGPT_CONSOLE_URL?.trim() || (CHANNEL === "prod" ? "https://mgpt.mn" : "https://dev.mgpt.mn")
export const WEB_APP_ORIGIN =
  process.env.MONGOLGPT_APP_ORIGIN?.trim() ||
  process.env.MONGOLGPT_APP_URL?.trim() ||
  (CHANNEL === "prod"
    ? "https://app.mgpt.mn"
    : CHANNEL === "beta"
      ? "https://app.beta.mgpt.mn"
      : "https://app.dev.mgpt.mn")
