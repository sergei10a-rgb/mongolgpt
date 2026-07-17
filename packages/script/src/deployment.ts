const booleanVariables = [
  "MONGOLGPT_ENABLE_HOSTED_SERVICES",
  "MONGOLGPT_ENABLE_ANALYTICS",
  "MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS",
  "MONGOLGPT_ENABLE_LEGACY_STRIPE",
  "MONGOLGPT_ENABLE_MONITORING",
  "MONGOLGPT_ENABLE_SHARE_SERVICE",
  "MONGOLGPT_ENABLE_SYNC_SERVICE",
] as const

type Environment = Record<string, string | undefined>

export class DeploymentPreflightError extends Error {
  constructor(readonly issues: string[]) {
    super(`Deploy-ийн урьдчилсан шалгалт амжилтгүй боллоо:\n- ${issues.join("\n- ")}`)
    this.name = "DeploymentPreflightError"
  }
}

export type DeploymentPreflightResult = {
  stage: string
  domain: string
  stageDomain: string
  hostedServices: boolean
  warnings: string[]
}

export function preflightDeployment(input: {
  stage: string
  env: Environment
  requireCloudflareCredentials?: boolean
}): DeploymentPreflightResult {
  const issues: string[] = []
  const warnings: string[] = []
  const stage = input.stage.trim().toLowerCase()
  const env = input.env

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(stage)) {
    issues.push("Deployment stage нь жижиг латин үсэг, тоо, дундах зураасаас бүрдэх ёстой.")
  }

  const domain = validateDomain(env.MONGOLGPT_DOMAIN, issues)
  for (const name of booleanVariables) validateBoolean(name, env[name], issues)

  if (input.requireCloudflareCredentials !== false) {
    requireValue("CLOUDFLARE_API_TOKEN", env.CLOUDFLARE_API_TOKEN, issues)
    requireValue("CLOUDFLARE_DEFAULT_ACCOUNT_ID", env.CLOUDFLARE_DEFAULT_ACCOUNT_ID, issues)
  }

  const hostedServices = enabled(env.MONGOLGPT_ENABLE_HOSTED_SERVICES)
  const optionalServices = [
    "MONGOLGPT_ENABLE_ANALYTICS",
    "MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS",
    "MONGOLGPT_ENABLE_LEGACY_STRIPE",
    "MONGOLGPT_ENABLE_MONITORING",
    "MONGOLGPT_ENABLE_SHARE_SERVICE",
    "MONGOLGPT_ENABLE_SYNC_SERVICE",
  ] as const
  if (!hostedServices) {
    for (const name of optionalServices) {
      if (enabled(env[name])) issues.push(`${name} нь hosted service унтраалттай үед true байж болохгүй.`)
    }
    warnings.push("Зөвхөн docs болон web app deploy хийнэ; account, auth, Free Auto API асахгүй.")
  }

  if (enabled(env.MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS)) {
    issues.push("AWS SES агуулсан business integrations Cloudflare-only launch-д одоогоор дэмжигдээгүй.")
  }
  if (enabled(env.MONGOLGPT_ENABLE_LEGACY_STRIPE)) {
    issues.push("Legacy Stripe billing хаалттай. MongolGPT-ийн төлбөр Bonum + QPay adapter-аар хэрэгжинэ.")
  }

  if (hostedServices && stage !== "production") {
    requireValue("MONGOLGPT_AUTH_EMAIL_DOMAINS", env.MONGOLGPT_AUTH_EMAIL_DOMAINS, issues)
  }
  if (hostedServices) validateSecretKey("BYOK_CREDENTIALS_KEY_V1", env.BYOK_CREDENTIALS_KEY_V1, issues)

  if (stage === "production" && domain) {
    const expected = `DEPLOY ${domain}`
    if (env.MONGOLGPT_PRODUCTION_CONFIRMATION !== expected) {
      issues.push(`Production deploy-г баталгаажуулахын тулд MONGOLGPT_PRODUCTION_CONFIRMATION="${expected}" гэж өгнө.`)
    }
  }

  if (issues.length) throw new DeploymentPreflightError(issues)
  return {
    stage,
    domain,
    stageDomain: stage === "production" ? domain : `${stage}.${domain}`,
    hostedServices,
    warnings,
  }
}

export function deploymentEndpoints(result: DeploymentPreflightResult) {
  const root = `https://${result.stageDomain}`
  return {
    docs: `https://docs.${result.stageDomain}/docs`,
    app: `https://app.${result.stageDomain}`,
    ...(result.hostedServices
      ? {
          console: root,
          consoleHealth: `${root}/api/health`,
          authHealth: `https://auth.${result.stageDomain}/health`,
        }
      : {}),
  }
}

function enabled(value: string | undefined) {
  return value === "true"
}

function validateBoolean(name: string, value: string | undefined, issues: string[]) {
  if (value === undefined || value === "") return
  if (value !== "true" && value !== "false") issues.push(`${name} нь зөвхөн true эсвэл false байна.`)
}

function requireValue(name: string, value: string | undefined, issues: string[]) {
  if (!value?.trim()) issues.push(`${name} дутуу байна.`)
}

function validateSecretKey(name: string, value: string | undefined, issues: string[]) {
  const secret = value?.trim()
  if (!secret) {
    issues.push(`${name} дутуу байна.`)
    return
  }
  if (secret.length < 32) issues.push(`${name} хамгийн багадаа 32 тэмдэгттэй байна.`)
}

function validateDomain(value: string | undefined, issues: string[]) {
  const domain = value?.trim().toLowerCase() ?? ""
  if (!domain) {
    issues.push("MONGOLGPT_DOMAIN дутуу байна.")
    return ""
  }
  if (domain.includes("://") || domain.includes("/") || domain.includes(":")) {
    issues.push("MONGOLGPT_DOMAIN-д protocol, path эсвэл port оруулахгүй; жишээ нь mgpt.mn.")
    return domain
  }
  if (domain === "localhost" || domain.endsWith(".localhost") || domain.endsWith(".example")) {
    issues.push("MONGOLGPT_DOMAIN нь placeholder эсвэл localhost байж болохгүй.")
  }
  if (domain.endsWith(".duckdns.org")) {
    issues.push("DuckDNS жишээ domain ашиглахгүй; MongolGPT-ийн өөрийн domain-ийг өгнө.")
  }
  if (domain.length > 253 || !domain.includes(".")) issues.push("MONGOLGPT_DOMAIN хүчинтэй бүрэн domain биш байна.")
  for (const label of domain.split(".")) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      issues.push(`MONGOLGPT_DOMAIN-ийн "${label}" хэсэг хүчинтэй биш.`)
      break
    }
  }
  return domain
}
