import type { Configuration } from "electron-builder"
import config from "./electron-builder.config"

if (process.env.MONGOLGPT_CHANNEL !== "dev") {
  throw new Error("Ad-hoc macOS packaging is restricted to explicit dev previews")
}

export default {
  ...config,
  mac: { ...config.mac, identity: "-", notarize: false },
  dmg: { ...config.dmg, sign: false },
} satisfies Configuration
