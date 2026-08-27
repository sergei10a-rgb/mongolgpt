import { docsUrl } from "./docs"
import { appOrigin, domain, publicOrigin, runtimeOrigin } from "./stage"

export { docsUrl, website } from "./docs"

const supportUrl = `${publicOrigin}/support`
const hostedServices = process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES === "true"
const channel = $app.stage === "production" ? "prod" : $app.stage === "dev" ? "dev" : "beta"

export const webApp = new sst.cloudflare.StaticSiteV2("WebApp", {
  domain: `app.${domain}`,
  path: "packages/app",
  build: {
    command: "bun run build:hosted",
    output: "./dist",
  },
  environment: {
    VITE_MONGOLGPT_APP_URL: appOrigin,
    VITE_MONGOLGPT_PUBLIC_URL: publicOrigin,
    VITE_MONGOLGPT_DOCS_URL: docsUrl,
    VITE_MONGOLGPT_SUPPORT_URL: supportUrl,
    MONGOLGPT_CHANNEL: channel,
    ...(hostedServices ? { VITE_MONGOLGPT_SERVER_URL: runtimeOrigin } : {}),
  },
})
