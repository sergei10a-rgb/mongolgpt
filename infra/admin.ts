import { adminOrigin, domain } from "./stage"
import { database, paymentService } from "./console"
import { SECRET } from "./secret"

class LocalCommand extends $util.CustomResource {
  constructor(name: string, args: $util.Inputs, opts?: $util.CustomResourceOptions) {
    super("command:local:Command", name, args, opts)
  }
}

const accessApiToken = process.env.CLOUDFLARE_ACCESS_API_TOKEN?.trim()
if (!accessApiToken) {
  throw new Error("Admin deploy-д CLOUDFLARE_ACCESS_API_TOKEN заавал байна.")
}

const accessProvider = new cloudflare.Provider("AdminAccessProvider", {
  apiToken: $util.secret(accessApiToken),
})
const accountId = sst.cloudflare.DEFAULT_ACCOUNT_ID
const hostname = `admin.${domain}`
const bootstrapEmails = new sst.Secret("MongolGPTAdminBootstrapEmails")
const configureOrganizationMfa = "bun run script/cloudflare-access-mfa.ts"
// The command has no delete action so removing a stack cannot silently weaken organization MFA.
const accessOrganizationMfa = new LocalCommand(
  "AdminAccessOrganizationMfa",
  {
    addPreviousOutputInEnv: false,
    create: configureOrganizationMfa,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_ACCESS_API_TOKEN: $util.secret(accessApiToken),
    },
    logging: "none",
    triggers: ["organization-mfa-v1", Date.now().toString()],
    update: configureOrganizationMfa,
  },
  {
    additionalSecretOutputs: ["stdout", "stderr"],
  },
)
const mfaConfig = {
  allowedAuthenticators: ["totp", "biometrics", "security_key"],
  mfaDisabled: false,
  sessionDuration: "1h",
}
const accessOrganization = cloudflare.getZeroTrustOrganizationOutput({ accountId }, { provider: accessProvider })
const accessApplication = new cloudflare.ZeroTrustAccessApplication(
  "AdminAccessApplication",
  {
    accountId,
    allowAuthenticateViaWarp: false,
    allowIframe: false,
    appLauncherVisible: false,
    customDenyMessage: "Энэ хэсэг зөвхөн MongolGPT-ийн эрх бүхий администраторт нээлттэй.",
    destinations: [{ type: "public", uri: hostname }],
    domain: hostname,
    enableBindingCookie: true,
    httpOnlyCookieAttribute: true,
    landingPageDesign: {
      message: "Админ хэсэгт нэвтрэхийн тулд эрх бүхий аккаунтаа баталгаажуулна уу.",
      title: "MongolGPT админ",
    },
    mfaConfig,
    name: `MongolGPT Admin (${$app.stage})`,
    optionsPreflightBypass: false,
    policies: bootstrapEmails.value.apply((value) => [
      {
        decision: "allow",
        includes: parseBootstrapEmails(value).map((email) => ({ email: { email } })),
        mfaConfig,
        name: "MongolGPT администраторууд",
        precedence: 1,
      },
    ]),
    sameSiteCookieAttribute: "strict",
    sessionDuration: "4h",
    type: "self_hosted",
  },
  { dependsOn: [accessOrganizationMfa], provider: accessProvider },
)
const accessConfig = new sst.Linkable("AdminAccessConfig", {
  properties: {
    audience: accessApplication.aud,
    teamDomain: accessOrganization.authDomain.apply(normalizeTeamDomain),
  },
})

export const admin = new sst.cloudflare.x.SolidStart("Admin", {
  domain: hostname,
  path: "packages/console/admin",
  link: [database, paymentService, accessConfig, bootstrapEmails, SECRET.AdminPaymentCancellationToken],
  environment: {
    MONGOLGPT_ADMIN_ORIGIN: adminOrigin,
  },
})

export const adminUrl = admin.url

function parseBootstrapEmails(value: string) {
  const emails = [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  if (!emails.length) throw new Error("MongolGPTAdminBootstrapEmails дутуу байна.")
  if (emails.some((email) => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("MongolGPTAdminBootstrapEmails дотор хүчинтэй имэйл хаягууд өгнө.")
  }
  return emails
}

function normalizeTeamDomain(value: string) {
  const raw = value.trim()
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`)
  if (
    url.protocol !== "https:" ||
    url.hostname === "cloudflareaccess.com" ||
    !url.hostname.endsWith(".cloudflareaccess.com") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("Cloudflare Zero Trust organization-ийн team domain хүчинтэй биш байна.")
  }
  return url.origin
}
