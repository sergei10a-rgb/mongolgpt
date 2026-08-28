import { resolveHostedServiceUrls } from "@mongolgpt/account-contract/service-urls"
import {
  modelConfigurationStageIssues,
  MongolGPTModelConfigurationSchema,
} from "@mongolgpt/console-core/model-config.js"
import { PaymentPlanCatalogSchema } from "@mongolgpt/console-core/payment-checkout.js"
import { Subscription } from "@mongolgpt/console-core/subscription.js"
import { inspectOAuthProviderConfiguration } from "@mongolgpt/console-core/oauth-provider-config.js"
import { inspectDeploymentStage } from "./deployment-stage"

const booleanVariables = [
  "MONGOLGPT_ENABLE_HOSTED_SERVICES",
  "MONGOLGPT_ENABLE_ANALYTICS",
  "MONGOLGPT_ENABLE_D1_BACKUPS",
  "MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS",
  "MONGOLGPT_ENABLE_LEGACY_STRIPE",
  "MONGOLGPT_ENABLE_MONITORING",
  "MONGOLGPT_ENABLE_TURNSTILE",
  "MONGOLGPT_ENABLE_SHARE_SERVICE",
  "MONGOLGPT_ENABLE_SYNC_SERVICE",
  "MONGOLGPT_ENABLE_ADMIN",
  "MONGOLGPT_ENABLE_REAL_PAYMENTS",
  "MONGOLGPT_DEPLOY_DOCS_ONLY",
  "MONGOLGPT_DEPLOY_APP_ONLY",
] as const

export const modelSecretNames = Array.from({ length: 30 }, (_, index) => `MONGOLGPT_GATEWAY_MODELS${index + 1}`)
export const paymentSstSecretNames = [
  "QPayMerchantAccountID",
  "QPayClientID",
  "QPayClientSecret",
  "QPayInvoiceCode",
  "BonumMerchantAccountID",
  "BonumAppSecret",
  "BonumTerminalID",
  "BonumWebhookChecksumKey",
] as const
export const hostedSstSecretNames = [
  "ByokCredentialsKeyV1",
  "D1BackupApiToken",
  "GITHUB_CLIENT_ID_CONSOLE",
  "GITHUB_CLIENT_SECRET_CONSOLE",
  "GOOGLE_CLIENT_ID",
  "MONGOLGPT_PLAN_LIMITS",
  "MongolGPTRuntimeAuthSecret",
  "TurnstileSecretKey",
  "MONGOLGPT_GATEWAY_SESSION_SECRET",
  "MongolGPTAdminBootstrapEmails",
  ...paymentSstSecretNames,
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
  adminEnabled: boolean
  backupsEnabled: boolean
  monitoringEnabled: boolean
  turnstileEnabled: boolean
  paymentEnvironment: "disabled" | "sandbox" | "production"
  warnings: string[]
}

export function preflightDeployment(input: {
  stage: string
  env: Environment
  requireCloudflareCredentials?: boolean
  requireDeploymentSecrets?: boolean
  requireHostedServices?: boolean
  scope?: "full" | "auth-bootstrap" | "docs-only" | "app-only" | "runtime-only"
}): DeploymentPreflightResult {
  const issues: string[] = []
  const warnings: string[] = []
  const inspectedStage = inspectDeploymentStage(input.stage)
  const stage = inspectedStage.stage
  const env = input.env
  const scope = input.scope ?? "full"

  if (scope === "auth-bootstrap" && stage !== "dev") {
    issues.push("OAuth bootstrap scope-ийг зөвхөн dev орчинд ашиглана.")
  }
  if (scope === "docs-only" && stage !== "dev") {
    issues.push("Docs-only scope-ийг зөвхөн dev орчинд ашиглана.")
  }
  if (scope === "app-only" && stage !== "dev") {
    issues.push("App-only scope-ийг зөвхөн dev орчинд ашиглана.")
  }
  if (scope === "runtime-only" && stage !== "dev") {
    issues.push("Runtime-only scope-ийг зөвхөн dev орчинд ашиглана.")
  }

  if (inspectedStage.issue) issues.push(inspectedStage.issue)

  const domain = validateDomain(env.MONGOLGPT_DOMAIN, issues)
  for (const name of booleanVariables) validateBoolean(name, env[name], issues)

  if (input.requireCloudflareCredentials !== false) {
    requireValue("CLOUDFLARE_API_TOKEN", env.CLOUDFLARE_API_TOKEN, issues)
    requireValue("CLOUDFLARE_DEFAULT_ACCOUNT_ID", env.CLOUDFLARE_DEFAULT_ACCOUNT_ID, issues)
  }

  const hostedServices = enabled(env.MONGOLGPT_ENABLE_HOSTED_SERVICES)
  const deployDocsOnly = enabled(env.MONGOLGPT_DEPLOY_DOCS_ONLY)
  const deployAppOnly = enabled(env.MONGOLGPT_DEPLOY_APP_ONLY)
  if (deployDocsOnly && deployAppOnly) {
    issues.push("MONGOLGPT_DEPLOY_DOCS_ONLY болон MONGOLGPT_DEPLOY_APP_ONLY-г хамтад нь ашиглахгүй.")
  }
  if (scope === "docs-only" && !deployDocsOnly) {
    issues.push("Docs-only scope нь MONGOLGPT_DEPLOY_DOCS_ONLY=true байхыг шаардана.")
  }
  if (scope !== "docs-only" && deployDocsOnly) {
    issues.push("MONGOLGPT_DEPLOY_DOCS_ONLY-г зөвхөн docs-only scope-той ашиглана.")
  }
  if (scope === "docs-only" && hostedServices) {
    issues.push("Docs-only scope нь MONGOLGPT_ENABLE_HOSTED_SERVICES=false байхыг шаардана.")
  }
  if (scope === "app-only" && !deployAppOnly) {
    issues.push("App-only scope нь MONGOLGPT_DEPLOY_APP_ONLY=true байхыг шаардана.")
  }
  if (scope !== "app-only" && deployAppOnly) {
    issues.push("MONGOLGPT_DEPLOY_APP_ONLY-г зөвхөн app-only scope-той ашиглана.")
  }
  if (scope === "app-only" && !hostedServices) {
    issues.push("App-only scope нь MONGOLGPT_ENABLE_HOSTED_SERVICES=true байхыг шаардана.")
  }
  const adminEnabled = enabled(env.MONGOLGPT_ENABLE_ADMIN)
  const backupsEnabled = enabled(env.MONGOLGPT_ENABLE_D1_BACKUPS)
  const monitoringEnabled = enabled(env.MONGOLGPT_ENABLE_MONITORING)
  const turnstileEnabled = enabled(env.MONGOLGPT_ENABLE_TURNSTILE)
  const paymentEnvironment = validatePaymentEnvironment(env.MONGOLGPT_PAYMENT_ENVIRONMENT, issues)
  const requireDeploymentSecrets = input.requireDeploymentSecrets !== false
  const optionalServices = [
    "MONGOLGPT_ENABLE_ANALYTICS",
    "MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS",
    "MONGOLGPT_ENABLE_LEGACY_STRIPE",
    "MONGOLGPT_ENABLE_MONITORING",
    "MONGOLGPT_ENABLE_TURNSTILE",
    "MONGOLGPT_ENABLE_SHARE_SERVICE",
    "MONGOLGPT_ENABLE_SYNC_SERVICE",
  ] as const
  if (scope === "app-only" || scope === "runtime-only") {
    for (const name of [...optionalServices, "MONGOLGPT_ENABLE_ADMIN", "MONGOLGPT_ENABLE_D1_BACKUPS"] as const) {
      if (enabled(env[name])) issues.push(`${name} нь ${scope} deploy үед false байна.`)
    }
    if (paymentEnvironment !== "disabled") {
      issues.push(`MONGOLGPT_PAYMENT_ENVIRONMENT нь ${scope} deploy үед disabled байна.`)
    }
    if (scope === "app-only") {
      warnings.push("Зөвхөн hosted web app Worker deploy хийнэ; backend resource өөрчлөхгүй.")
    } else {
      warnings.push("Зөвхөн dev runtime Worker болон Cloudflare Sandbox container deploy хийнэ.")
    }
  }
  if (!hostedServices) {
    for (const name of optionalServices) {
      if (enabled(env[name])) issues.push(`${name} нь hosted service унтраалттай үед true байж болохгүй.`)
    }
    warnings.push("Зөвхөн docs болон web app deploy хийнэ; account, auth, Free Auto API асахгүй.")
  }
  if (input.requireHostedServices && !hostedServices) {
    issues.push(
      "Нийтийн MongolGPT Web app deploy хийхэд MONGOLGPT_ENABLE_HOSTED_SERVICES=true заавал байна; local-bridge build-ийг SaaS app гэж нийтлэхгүй.",
    )
  }

  if (adminEnabled && !hostedServices) {
    issues.push("MONGOLGPT_ENABLE_ADMIN нь hosted services асаалттай үед л true байж болно.")
  }
  if (backupsEnabled && !hostedServices) {
    issues.push("MONGOLGPT_ENABLE_D1_BACKUPS нь байршуулсан үйлчилгээнүүд асаалттай үед л true байж болно.")
  }
  if (paymentEnvironment !== "disabled" && !hostedServices) {
    issues.push("MONGOLGPT_PAYMENT_ENVIRONMENT нь hosted services асаалттай үед л sandbox эсвэл production байж болно.")
  }
  if (hostedServices && stage === "production" && !adminEnabled) {
    issues.push("Production hosted launch-д MONGOLGPT_ENABLE_ADMIN=true заавал байна.")
  }
  if (hostedServices && stage === "production" && !backupsEnabled) {
    issues.push("Үйлдвэрлэлийн үйлчилгээ байршуулалтад MONGOLGPT_ENABLE_D1_BACKUPS=true заавал байна.")
  }
  if (hostedServices && stage === "production" && !monitoringEnabled) {
    issues.push("Үйлдвэрлэлийн үйлчилгээ байршуулалтад MONGOLGPT_ENABLE_MONITORING=true заавал байна.")
  }
  if (hostedServices && stage === "production" && !turnstileEnabled) {
    issues.push("Үйлдвэрлэлийн үйлчилгээ байршуулалтад MONGOLGPT_ENABLE_TURNSTILE=true заавал байна.")
  }
  if (hostedServices && !backupsEnabled) {
    warnings.push("Энэ орчинд өдөр тутмын D1 нөөцлөлтийн автомат ажиллагаа идэвхгүй байна.")
  }
  if (hostedServices && !monitoringEnabled) {
    warnings.push("Энэ орчинд Cloudflare-ийн үйлчилгээний автомат хяналт идэвхгүй байна.")
  }
  if (hostedServices && !turnstileEnabled) {
    warnings.push("Энэ орчинд OAuth нэвтрэх эхлэл Cloudflare Turnstile хамгаалалтгүй байна.")
  }

  if (hostedServices && turnstileEnabled) {
    validateTurnstileKey("MONGOLGPT_TURNSTILE_SITE_KEY", env.MONGOLGPT_TURNSTILE_SITE_KEY, stage, issues)
    if (requireDeploymentSecrets) {
      validateTurnstileKey("TurnstileSecretKey", deploymentSecret(env, "TurnstileSecretKey"), stage, issues)
    }
  }

  if (adminEnabled && requireDeploymentSecrets) {
    requireValue("CLOUDFLARE_ACCESS_API_TOKEN", env.CLOUDFLARE_ACCESS_API_TOKEN, issues)
    validateBootstrapEmails(deploymentSecret(env, "MongolGPTAdminBootstrapEmails"), issues)
  }

  if (enabled(env.MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS)) {
    issues.push("AWS SES агуулсан business integrations Cloudflare-only launch-д одоогоор дэмжигдээгүй.")
  }
  if (enabled(env.MONGOLGPT_ENABLE_LEGACY_STRIPE)) {
    issues.push("Legacy Stripe billing хаалттай. MongolGPT-ийн төлбөр Bonum + QPay adapter-аар хэрэгжинэ.")
  }

  if (hostedServices && stage !== "production" && scope !== "app-only" && scope !== "runtime-only") {
    requireValue("MONGOLGPT_AUTH_EMAIL_DOMAINS", env.MONGOLGPT_AUTH_EMAIL_DOMAINS, issues)
  }
  if (hostedServices && requireDeploymentSecrets) {
    if (scope !== "auth-bootstrap") {
      validateSecretKey("MONGOLGPT_RUNTIME_SECRET", env.MONGOLGPT_RUNTIME_SECRET, issues)
    }
    validateSecretKey("MONGOLGPT_RUNTIME_AUTH_SECRET", env.MONGOLGPT_RUNTIME_AUTH_SECRET, issues)
    if (scope !== "runtime-only") {
      const linkedRuntimeAuthSecret = deploymentSecret(env, "MongolGPTRuntimeAuthSecret")
      validateSecretKey("SST_SECRET_MongolGPTRuntimeAuthSecret", linkedRuntimeAuthSecret, issues)
      if (
        env.MONGOLGPT_RUNTIME_AUTH_SECRET?.trim() &&
        linkedRuntimeAuthSecret?.trim() &&
        env.MONGOLGPT_RUNTIME_AUTH_SECRET !== linkedRuntimeAuthSecret
      ) {
        issues.push("MONGOLGPT_RUNTIME_AUTH_SECRET болон SST_SECRET_MongolGPTRuntimeAuthSecret ижил утгатай байна.")
      }
      if (backupsEnabled) requireValue("D1_BACKUP_API_TOKEN", deploymentSecret(env, "D1BackupApiToken"), issues)
      const oauth = inspectOAuthProviderConfiguration({
        stage,
        githubClientID: deploymentSecret(env, "GITHUB_CLIENT_ID_CONSOLE"),
        githubClientSecret: deploymentSecret(env, "GITHUB_CLIENT_SECRET_CONSOLE"),
        googleClientID: deploymentSecret(env, "GOOGLE_CLIENT_ID"),
      })
      issues.push(...oauth.issues)
      validateSecretKey("BYOK_CREDENTIALS_KEY_V1", deploymentSecret(env, "ByokCredentialsKeyV1"), issues)
      validatePlanConfiguration(deploymentSecret(env, "MONGOLGPT_PLAN_LIMITS"), issues)
      validateSecretKey(
        "MONGOLGPT_GATEWAY_SESSION_SECRET",
        deploymentSecret(env, "MONGOLGPT_GATEWAY_SESSION_SECRET"),
        issues,
      )
      if (scope === "full") validateModelConfiguration(modelConfiguration(env), issues, stage)
    }
  }
  validatePaymentConfiguration({
    env,
    stage,
    stageDomain: stage === "production" ? domain : `${stage}.${domain}`,
    hostedServices,
    paymentEnvironment,
    requireDeploymentSecrets,
    issues,
  })

  if (stage === "production" && domain) {
    const expected = `DEPLOY ${domain}`
    if (env.MONGOLGPT_PRODUCTION_CONFIRMATION !== expected) {
      issues.push(`Production deploy-г баталгаажуулахын тулд MONGOLGPT_PRODUCTION_CONFIRMATION="${expected}" гэж өгнө.`)
    }
  }

  if (issues.length) throw new DeploymentPreflightError(issues)
  const serviceUrls = resolveHostedServiceUrls(domain, stage)
  return {
    stage,
    domain,
    stageDomain: serviceUrls.stageDomain,
    hostedServices,
    adminEnabled,
    backupsEnabled,
    monitoringEnabled,
    turnstileEnabled,
    paymentEnvironment,
    warnings,
  }
}

export function deploymentEndpoints(result: DeploymentPreflightResult) {
  const urls = resolveHostedServiceUrls(result.domain, result.stage)
  if (urls.stageDomain !== result.stageDomain)
    throw new Error("Deployment stage domain shared contract-той зөрж байна.")
  return {
    docs: urls.docs,
    app: urls.app,
    ...(result.hostedServices
      ? {
          console: urls.console,
          consoleHealth: `${urls.console}/api/health`,
          authHealth: `${urls.auth}/health`,
          runtimeHealth: `${urls.runtime}/global/health`,
          paymentHealth: `${urls.payment}/health`,
        }
      : {}),
    ...(result.adminEnabled ? { admin: urls.admin } : {}),
  }
}

function enabled(value: string | undefined) {
  return value === "true"
}

function validateBoolean(name: string, value: string | undefined, issues: string[]) {
  if (value === undefined || value === "") return
  if (value !== "true" && value !== "false") issues.push(`${name} нь зөвхөн true эсвэл false байна.`)
}

function validatePaymentEnvironment(value: string | undefined, issues: string[]) {
  const environment = value?.trim() || "disabled"
  if (environment === "disabled" || environment === "sandbox" || environment === "production") return environment
  issues.push("MONGOLGPT_PAYMENT_ENVIRONMENT нь disabled, sandbox эсвэл production байна.")
  return "disabled"
}

function requireValue(name: string, value: string | undefined, issues: string[]) {
  if (!value?.trim()) issues.push(`${name} дутуу байна.`)
}

function deploymentSecret(env: Environment, name: string) {
  return env[`SST_SECRET_${name}`] ?? env[name]
}

function modelConfiguration(env: Environment) {
  return modelSecretNames.map((name) => deploymentSecret(env, name) ?? "").join("")
}

function validateSecretKey(name: string, value: string | undefined, issues: string[]) {
  const secret = value?.trim()
  if (!secret) {
    issues.push(`${name} дутуу байна.`)
    return
  }
  if (secret.length < 32) issues.push(`${name} хамгийн багадаа 32 тэмдэгттэй байна.`)
}

function validateTurnstileKey(name: string, value: string | undefined, stage: string, issues: string[]) {
  const key = value?.trim() ?? ""
  if (!key) {
    issues.push(`${name} дутуу байна.`)
    return
  }
  if (key === "disabled" || placeholderValue(key) || !/^[A-Za-z0-9_-]{20,128}$/.test(key)) {
    issues.push(`${name} хүчинтэй Cloudflare Turnstile key байна.`)
    return
  }
  if (stage === "production" && /^[123]x0{10,}/.test(key)) {
    issues.push(`${name}-д Cloudflare-ийн test key-г production орчинд ашиглахгүй.`)
  }
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
  issues.push(`MONGOLGPT_PLAN_LIMITS нь төлөвлөгөө, квотын схемд нийцэхгүй байна. ${details}`)
}

function validatePaymentConfiguration(input: {
  env: Environment
  stage: string
  stageDomain: string
  hostedServices: boolean
  paymentEnvironment: "disabled" | "sandbox" | "production"
  requireDeploymentSecrets: boolean
  issues: string[]
}) {
  if (input.paymentEnvironment === "disabled") return

  validatePaymentCatalog(input.env.MONGOLGPT_PAYMENT_PLAN_CATALOG, input.issues)
  if (input.paymentEnvironment === "sandbox" && input.stage === "production") {
    input.issues.push("Production stage-д sandbox төлбөр ажиллуулахгүй; disabled эсвэл production сонгоно.")
  }
  if (input.paymentEnvironment === "production") {
    if (input.stage !== "production") {
      input.issues.push("Production төлбөрийг зөвхөн production stage-д асаана.")
    }
    if (!enabled(input.env.MONGOLGPT_ENABLE_REAL_PAYMENTS)) {
      input.issues.push("Production төлбөрт MONGOLGPT_ENABLE_REAL_PAYMENTS=true заавал байна.")
    }
    const expected = `ENABLE REAL PAYMENTS ${input.stageDomain}`
    if (input.env.MONGOLGPT_REAL_PAYMENT_CONFIRMATION !== expected) {
      input.issues.push(
        `Бодит төлбөрийг баталгаажуулахын тулд MONGOLGPT_REAL_PAYMENT_CONFIRMATION="${expected}" гэж өгнө.`,
      )
    }
  }
  if (!input.hostedServices || !input.requireDeploymentSecrets) return

  const paymentSecret = (name: (typeof paymentSstSecretNames)[number]) =>
    deploymentSecret(input.env, name)?.trim() ?? ""
  const values = {
    QPayMerchantAccountID: paymentSecret("QPayMerchantAccountID"),
    QPayClientID: paymentSecret("QPayClientID"),
    QPayClientSecret: paymentSecret("QPayClientSecret"),
    QPayInvoiceCode: paymentSecret("QPayInvoiceCode"),
    BonumMerchantAccountID: paymentSecret("BonumMerchantAccountID"),
    BonumAppSecret: paymentSecret("BonumAppSecret"),
    BonumTerminalID: paymentSecret("BonumTerminalID"),
    BonumWebhookChecksumKey: paymentSecret("BonumWebhookChecksumKey"),
  } satisfies Record<(typeof paymentSstSecretNames)[number], string>
  const missing = paymentSstSecretNames.filter((name) => !values[name])
  for (const name of missing) input.issues.push(`${name} дутуу байна.`)
  if (missing.length) return

  for (const name of paymentSstSecretNames) {
    if (values[name] === "disabled" || placeholderValue(values[name])) {
      input.issues.push(`${name} бодит merchant credential-тэй байна.`)
    }
  }
  if (paymentSstSecretNames.some((name) => values[name] === "disabled" || placeholderValue(values[name]))) return

  if (!validQPayCredentials(values)) {
    input.issues.push("QPay худалдааны байгууллагын нэвтрэх мэдээлэл шаардлагатай бүтцэд нийцэхгүй байна.")
  }

  if (!validBonumCredentials(values)) {
    input.issues.push("Bonum худалдааны байгууллагын нэвтрэх мэдээлэл шаардлагатай бүтцэд нийцэхгүй байна.")
  }
}

function validQPayCredentials(values: Record<(typeof paymentSstSecretNames)[number], string>) {
  return (
    bounded(values.QPayMerchantAccountID, 1, 255, true) &&
    bounded(values.QPayClientID, 1, 255, true) &&
    !values.QPayClientID.includes(":") &&
    printableAscii(values.QPayClientID) &&
    bounded(values.QPayClientSecret, 1, 2_048) &&
    printableAscii(values.QPayClientSecret) &&
    bounded(values.QPayInvoiceCode, 1, 45, true)
  )
}

function validBonumCredentials(values: Record<(typeof paymentSstSecretNames)[number], string>) {
  return (
    bounded(values.BonumMerchantAccountID, 1, 255, true) &&
    bounded(values.BonumAppSecret, 1, 4_096) &&
    printableAscii(values.BonumAppSecret) &&
    /^\d{1,32}$/.test(values.BonumTerminalID.trim()) &&
    bounded(values.BonumWebhookChecksumKey, 16, 4_096)
  )
}

function bounded(value: string, minimum: number, maximum: number, trim = false) {
  const length = trim ? value.trim().length : value.length
  return length >= minimum && length <= maximum
}

function printableAscii(value: string) {
  return /^[\x20-\x7e]+$/.test(value)
}

function validatePaymentCatalog(value: string | undefined, issues: string[]) {
  const raw = value?.trim()
  if (!raw) {
    issues.push("MONGOLGPT_PAYMENT_PLAN_CATALOG дутуу байна.")
    return
  }

  try {
    PaymentPlanCatalogSchema.parse(JSON.parse(raw))
  } catch {
    issues.push("MONGOLGPT_PAYMENT_PLAN_CATALOG нь Basic/Pro/Max MNT үнийн хүчинтэй JSON байна.")
  }
}

function validateModelConfiguration(value: string | undefined, issues: string[], stage: string) {
  const raw = value?.trim()
  if (!raw) {
    issues.push("MONGOLGPT_GATEWAY_MODELS1 дутуу байна.")
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    issues.push("MONGOLGPT_GATEWAY_MODELS1 хүчинтэй JSON биш байна.")
    return
  }

  const result = MongolGPTModelConfigurationSchema.safeParse(parsed)
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ")
    issues.push(`MONGOLGPT_GATEWAY_MODELS1 нь ажиллах орчны загварын схемд нийцэхгүй байна. ${details}`)
    return
  }

  const freeAuto = result.data.models["free-auto"]
  if (!freeAuto) {
    issues.push('MONGOLGPT_GATEWAY_MODELS1 нь models дотроо "free-auto" загвартай байна.')
    return
  }

  for (const issue of modelConfigurationStageIssues(result.data, stage)) {
    issues.push(`MONGOLGPT_GATEWAY_MODELS-ийн үйлдвэрлэлийн бодлого зөрчигдлөө. ${issue}`)
  }

  const referencedProviders = new Set<string>()
  for (const [listName, models] of [
    ["models", result.data.models],
    ["lightweightModels", result.data.lightweightModels],
  ] as const) {
    for (const [modelID, configured] of Object.entries(models)) {
      for (const modelConfig of Array.isArray(configured) ? configured : [configured]) {
        for (const route of modelConfig.providers) {
          referencedProviders.add(route.id)
          if (placeholderValue(route.model)) {
            issues.push(
              `MONGOLGPT_GATEWAY_MODELS дэх "${listName}.${modelID}" үйлчилгээ үзүүлэгчийн чиглэл бодит загварын ID-тай байна.`,
            )
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
      issues.push(`MONGOLGPT_GATEWAY_MODELS дэх "${providerID}" үйлчилгээ үзүүлэгч бодит API түлхүүртэй байна.`)
    }

    try {
      const url = new URL(api)
      if (url.protocol !== "https:") {
        issues.push(`MONGOLGPT_GATEWAY_MODELS дэх "${providerID}" үйлчилгээ үзүүлэгчийн API нь HTTPS байна.`)
      }
      if (placeholderValue(api) || reservedProviderHostname(url.hostname)) {
        issues.push(
          `MONGOLGPT_GATEWAY_MODELS дэх "${providerID}" үйлчилгээ үзүүлэгч бодит API төгсгөлийн цэгтэй байна.`,
        )
      }
      if (stage === "production" && nvidiaApiCatalogHostname(url.hostname) && provider.productionUseApproved !== true) {
        issues.push(
          `MONGOLGPT_GATEWAY_MODELS дэх "${providerID}" NVIDIA API Catalog үйлчилгээ үзүүлэгч нь үйлдвэрлэлийн захиалга, лиценз баталгаажсан productionUseApproved=true тохиргоотой байна.`,
        )
      }
    } catch {
      issues.push(`MONGOLGPT_GATEWAY_MODELS дэх "${providerID}" үйлчилгээ үзүүлэгчийн API URL хүчинтэй байна.`)
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

function validateBootstrapEmails(value: string | undefined, issues: string[]) {
  const emails = (value ?? "")
    .split(/[;,\n]/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
  if (!emails.length) {
    issues.push("MongolGPTAdminBootstrapEmails дутуу байна.")
    return
  }
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (emails.some((email) => !validEmail.test(email))) {
    issues.push("MongolGPTAdminBootstrapEmails дотор хүчинтэй email-үүдийг таслал эсвэл шинэ мөрөөр өгнө.")
  }
}
