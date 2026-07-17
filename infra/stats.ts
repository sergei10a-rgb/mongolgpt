import { database } from "./console"
import { domain } from "./stage"

export const app = new sst.cloudflare.x.SolidStart("Stats", {
  path: "packages/stats/app",
  buildCommand: "bun run build",
  domain: `stats.${domain}`,
  link: [database],
  environment: {
    PUBLIC_URL: `https://${domain}/data`,
  },
})
