import { docsOrigin, domain, publicOrigin } from "./stage"

const supportUrl = "https://github.com/sergei10a-rgb/mongolgpt/issues"
export const docsUrl = docsOrigin

export const website = new sst.cloudflare.x.Astro("Website", {
  domain: `docs.${domain}`,
  path: "packages/web",
  environment: {
    SST_STAGE: $app.stage,
    MONGOLGPT_PUBLIC_URL: publicOrigin,
    MONGOLGPT_CONSOLE_URL: publicOrigin,
    MONGOLGPT_SUPPORT_URL: supportUrl,
  },
})

export const webApp = new sst.cloudflare.StaticSite("WebApp", {
  domain: `app.${domain}`,
  path: "packages/app",
  build: {
    command: "bun turbo build",
    output: "./dist",
  },
  environment: {
    VITE_MONGOLGPT_PUBLIC_URL: publicOrigin,
    VITE_MONGOLGPT_DOCS_URL: docsUrl,
    VITE_MONGOLGPT_SUPPORT_URL: supportUrl,
    VITE_MONGOLGPT_CHANNEL: $app.stage === "production" ? "prod" : "beta",
  },
})
