import { adminOrigin, domain, enableD1Backups, enableMonitoring, runtimeOrigin } from "./stage"
import mongolGPTPackage from "../packages/mongolgpt/package.json"

class LocalCommand extends $util.CustomResource {
  constructor(name: string, args: $util.Inputs, opts?: $util.CustomResourceOptions) {
    super("command:local:Command", name, args, opts)
  }
}

export function createAdminDeployment(sharedLinks: readonly object[]) {
  const accessApiToken = process.env.CLOUDFLARE_ACCESS_API_TOKEN?.trim()
  if (!accessApiToken) {
    throw new Error("Admin deploy-д CLOUDFLARE_ACCESS_API_TOKEN заавал байна.")
  }

  const accessProvider = new cloudflare.Provider("AdminAccessProvider", {
    apiToken: $util.secret(accessApiToken),
  })
  const accountId = sst.cloudflare.DEFAULT_ACCOUNT_ID
  const hostname = `admin.${domain}`
  const releaseVersion = releaseVersionFromManifest(mongolGPTPackage.version)
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
      mfaConfig,
      name: `MongolGPT админ (${$app.stage})`,
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

  const admin = new sst.cloudflare.x.SolidStart("Admin", {
    domain: hostname,
    path: "packages/console/admin",
    link: [...sharedLinks, accessConfig, bootstrapEmails],
    environment: {
      MONGOLGPT_ADMIN_ORIGIN: adminOrigin,
      MONGOLGPT_RUNTIME_URL: runtimeOrigin,
      MONGOLGPT_RELEASE_VERSION: releaseVersion,
      MONGOLGPT_STAGE: $app.stage,
      MONGOLGPT_D1_BACKUPS_ENABLED: enableD1Backups ? "true" : "false",
      MONGOLGPT_MONITORING_ENABLED: enableMonitoring ? "true" : "false",
    },
  })

  return { admin, adminUrl: admin.url }
}

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

function releaseVersionFromManifest(value: unknown) {
  if (typeof value !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("packages/mongolgpt release хувилбар хүчинтэй биш байна.")
  }
  return value
}
