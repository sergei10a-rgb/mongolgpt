import { MongolGPTModelConfigurationSchema } from "@mongolgpt/console-core/model-config.js"
import { Subscription } from "@mongolgpt/console-core/subscription.js"

const booleanVariables = [
  "MONGOLGPT_ENABLE_HOSTED_SERVICES",
  "MONGOLGPT_ENABLE_ANALYTICS",
  "MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS",
  "MONGOLGPT_ENABLE_LEGACY_STRIPE",
  "MONGOLGPT_ENABLE_MONITORING",
  "MONGOLGPT_ENABLE_SHARE_SERVICE",
  "MONGOLGPT_ENABLE_SYNC_SERVICE",
] as const

export const modelSecretNames = Array.from({ length: 30 }, (_, index) => `ZEN_MODELS${index + 1}`)
export const hostedSstSecretNames = [
  "ByokCredentialsKeyV1",
  "GITHUB_CLIENT_ID_CONSOLE",
  "GITHUB_CLIENT_SECRET_CONSOLE",
  "GOOGLE_CLIENT_ID",
  "MONGOLGPT_PLAN_LIMITS",
  "ZEN_SESSION_SECRET",
  ...modelSecretNames,
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
  if (hostedServices) {
    validateSecretKey("MONGOLGPT_RUNTIME_SECRET", env.MONGOLGPT_RUNTIME_SECRET, issues)
    requireValue("GITHUB_CLIENT_ID_CONSOLE", deploymentSecret(env, "GITHUB_CLIENT_ID_CONSOLE"), issues)
    requireValue("GITHUB_CLIENT_SECRET_CONSOLE", deploymentSecret(env, "GITHUB_CLIENT_SECRET_CONSOLE"), issues)
    requireValue("GOOGLE_CLIENT_ID", deploymentSecret(env, "GOOGLE_CLIENT_ID"), issues)
    validateSecretKey("BYOK_CREDENTIALS_KEY_V1", deploymentSecret(env, "ByokCredentialsKeyV1"), issues)
    validatePlanConfiguration(deploymentSecret(env, "MONGOLGPT_PLAN_LIMITS"), issues)
    validateSecretKey("ZEN_SESSION_SECRET", deploymentSecret(env, "ZEN_SESSION_SECRET"), issues)
    validateModelConfiguration(
      modelSecretNames.map((name) => deploymentSecret(env, name) ?? "").join(""),
      issues,
      stage,
    )
  }

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
          runtimeHealth: `https://runtime.${result.stageDomain}/global/health`,
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

function deploymentSecret(env: Environment, name: string) {
  return env[`SST_SECRET_${name}`] ?? env[name]
}

function validateSecretKey(name: string, value: string | undefined, issues: string[]) {
  const secret = value?.trim()
  if (!secret) {
    issues.push(`${name} дутуу байна.`)
    return
  }
  if (secret.length < 32) issues.push(`${name} хамгийн багадаа 32 тэмдэгттэй байна.`)
}

function validatePlanConfiguration(value: string | undefined, issues: string[]) {
  const raw = value?.trim()
  if (!raw) {
    issues.push("MONGOLGPT_PLAN_LIMITS дутуу байна.")
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    issues.push("MONGOLGPT_PLAN_LIMITS хүчинтэй JSON биш байна.")
    return
  }

  const result = Subscription.LimitsSchema.safeParse(parsed)
  if (result.success) return
  const details = result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ")
  issues.push(`MONGOLGPT_PLAN_LIMITS plan/quota schema-д нийцэхгүй байна. ${details}`)
}

function validateModelConfiguration(value: string | undefined, issues: string[], stage: string) {
  const raw = value?.trim()
  if (!raw) {
    issues.push("ZEN_MODELS1 дутуу байна.")
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    issues.push("ZEN_MODELS1 хүчинтэй JSON биш байна.")
    return
  }

  const result = MongolGPTModelConfigurationSchema.safeParse(parsed)
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ")
    issues.push(`ZEN_MODELS1 runtime model schema-д нийцэхгүй байна. ${details}`)
    return
  }

  const freeAuto = result.data.zenModels["free-auto"]
  if (!freeAuto) {
    issues.push('ZEN_MODELS1 нь zenModels дотроо "free-auto" model-той байна.')
    return
  }

  const referencedProviders = new Set<string>()
  for (const [listName, models] of [
    ["zenModels", result.data.zenModels],
    ["liteModels", result.data.liteModels],
  ] as const) {
    for (const [modelID, configured] of Object.entries(models)) {
      for (const modelConfig of Array.isArray(configured) ? configured : [configured]) {
        for (const route of modelConfig.providers) {
          referencedProviders.add(route.id)
          if (placeholderValue(route.model)) {
            issues.push(`ZEN_MODELS дэх "${listName}.${modelID}" provider route бодит model ID-тэй байна.`)
          }
        }
      }
    }
  }

  for (const providerID of referencedProviders) {
    const provider = result.data.providers[providerID]
    if (!provider) continue

    const api = provider.api.trim()
    const keys = typeof provider.apiKey === "string" ? [provider.apiKey] : Object.values(provider.apiKey)
    if (keys.length === 0 || keys.some((key) => !key.trim() || placeholderValue(key))) {
      issues.push(`ZEN_MODELS дэх "${providerID}" provider бодит API key-тэй байна.`)
    }

    try {
      const url = new URL(api)
      if (url.protocol !== "https:") {
        issues.push(`ZEN_MODELS дэх "${providerID}" provider-ийн API HTTPS байна.`)
      }
      if (placeholderValue(api) || reservedProviderHostname(url.hostname)) {
        issues.push(`ZEN_MODELS дэх "${providerID}" provider бодит API endpoint-тэй байна.`)
      }
      if (stage === "production" && nvidiaApiCatalogHostname(url.hostname) && provider.productionUseApproved !== true) {
        issues.push(
          `ZEN_MODELS дэх "${providerID}" NVIDIA API Catalog provider production subscription/license баталгаажсан productionUseApproved=true тохиргоотой байна.`,
        )
      }
    } catch {
      issues.push(`ZEN_MODELS дэх "${providerID}" provider-ийн API URL хүчинтэй байна.`)
    }
  }
}

function placeholderValue(value: string) {
  const normalized = value.trim()
  return (
    !normalized ||
    /^(?:your|sample)[-_ ]/i.test(normalized) ||
    /(?:replace[-_ ]?with|placeholder|example(?:\.com|\.org|\.net|[-_ ]?secret)|<[^>]+>)/i.test(normalized)
  )
}

function reservedProviderHostname(value: string) {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "")
  return (
    hostname === "example.com" ||
    hostname === "example.net" ||
    hostname === "example.org" ||
    [".invalid", ".test", ".example"].some((suffix) => hostname.endsWith(suffix))
  )
}

function nvidiaApiCatalogHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "") === "integrate.api.nvidia.com"
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
