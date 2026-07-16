import { SECRET } from "./secret"
import { domain, publicOrigin } from "./stage"

const storage = new sst.cloudflare.Bucket("EnterpriseStorage")

export const teams = new sst.cloudflare.x.SolidStart("Teams", {
  domain: `share.${domain}`,
  path: "packages/enterprise",
  buildCommand: "bun run build:cloudflare",
  link: [SECRET.SupportApiKey],
  environment: {
    MONGOLGPT_STORAGE_ADAPTER: "r2",
    MONGOLGPT_STORAGE_ACCOUNT_ID: sst.cloudflare.DEFAULT_ACCOUNT_ID,
    MONGOLGPT_STORAGE_ACCESS_KEY_ID: SECRET.R2AccessKey.value,
    MONGOLGPT_STORAGE_SECRET_ACCESS_KEY: SECRET.R2SecretKey.value,
    MONGOLGPT_STORAGE_BUCKET: storage.name,
    VITE_MONGOLGPT_PUBLIC_URL: publicOrigin,
    VITE_MONGOLGPT_COMMUNITY_URL: "https://github.com/sergei10a-rgb/mongolgpt/discussions",
  },
})
