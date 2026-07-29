import { adminOrigin, domain } from "./stage"
import { database } from "./console"

const accessTeamDomain = new sst.Secret("MongolGPTAdminAccessTeamDomain")
const accessAudience = new sst.Secret("MongolGPTAdminAccessAudience")
const bootstrapEmails = new sst.Secret("MongolGPTAdminBootstrapEmails")

export const admin = new sst.cloudflare.x.SolidStart("Admin", {
  domain: `admin.${domain}`,
  path: "packages/console/admin",
  link: [database, accessTeamDomain, accessAudience, bootstrapEmails],
  environment: {
    MONGOLGPT_ADMIN_ORIGIN: adminOrigin,
  },
})

export const adminUrl = admin.url
