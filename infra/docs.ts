import { docsOrigin, domain, publicOrigin } from "./stage"

const supportUrl = `${publicOrigin}/support`
export const docsUrl = docsOrigin

export const website = new sst.cloudflare.StaticSiteV2("Website", {
  domain: `docs.${domain}`,
  path: "packages/web",
  build: {
    command: "MONGOLGPT_STATIC_DOCS=true bun run build",
    output: "./dist",
  },
  environment: {
    SST_STAGE: $app.stage,
    MONGOLGPT_STATIC_DOCS: "true",
    MONGOLGPT_PUBLIC_URL: publicOrigin,
    MONGOLGPT_CONSOLE_URL: publicOrigin,
    MONGOLGPT_SUPPORT_URL: supportUrl,
  },
})
