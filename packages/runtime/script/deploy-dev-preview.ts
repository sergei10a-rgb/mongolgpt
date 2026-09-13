import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import candidate from "../wrangler.candidate.dev.json"
import { runCandidateCommand } from "./stage-dev-runtime"
import { verify } from "./probe-dev-runtime"

const root = fileURLToPath(new URL("..", import.meta.url))
const repository = "sergei10a-rgb/mongolgpt"
const confirmation = "DEPLOY OWNER DEV PREVIEW"
const accountID = "cc97ad90bfaf8a1da5de612eef2658f5"
const workerName = "mongolgpt-preview-dev"
const hostname = "preview.dev.mgpt.mn"
const rootZone = "mgpt.mn"
const ownerEmail = "sergei10a@gmail.com"
const maxResponseBytes = 65_536
type Requester = (url: string, init: RequestInit) => Promise<Response>

const mfaConfig = {
  allowed_authenticators: ["totp", "biometrics", "security_key"],
  mfa_disabled: false,
  session_duration: "1h",
}

export function previewDeployContext(env: NodeJS.ProcessEnv) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.RUNNER_OS !== "Linux" ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.MONGOLGPT_OWNER_DEV_PREVIEW_CONFIRMATION !== confirmation ||
    env.CLOUDFLARE_ACCOUNT_ID !== accountID ||
    !env.CLOUDFLARE_API_TOKEN?.trim() ||
    !env.CLOUDFLARE_ACCESS_API_TOKEN?.trim() ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !isAbsolute(env.RUNNER_TEMP ?? "")
  )
    throw new Error("Owner dev preview context is invalid")
  return {
    accountID,
    worker: workerName,
    sourceCommit: env.GITHUB_SHA!,
    run: `${env.GITHUB_RUN_ID!}:${env.GITHUB_RUN_ATTEMPT!}`,
    output: join(env.RUNNER_TEMP!, "runtime-dev-preview-receipt.json"),
  }
}

export function previewWranglerConfig(input: { accessAudience: string; accessTeamDomain: string }) {
  const accessAudience = input.accessAudience.trim()
  const accessTeamDomain = normalizeTeamDomain(input.accessTeamDomain)
  if (!/^[a-f0-9]{64}$/.test(accessAudience)) throw new Error("Preview Access audience is missing")
  if (accessTeamDomain !== "https://raspy-frog-02f6.cloudflareaccess.com")
    throw new Error("Preview Access team domain is invalid")
  return {
    name: workerName,
    account_id: accountID,
    main: join(root, "../console/admin/src/preview/worker.ts"),
    compatibility_date: candidate.compatibility_date,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: hostname, custom_domain: true }],
    assets: {
      directory: join(root, "../app/dist"),
      binding: "ASSETS",
      run_worker_first: true,
      not_found_handling: "single-page-application",
    },
    services: [{ binding: "CANDIDATE", service: candidate.name, remote: true }],
    vars: {
      STAGE: "dev",
      ACCESS_AUDIENCE: accessAudience,
      ACCESS_TEAM_DOMAIN: accessTeamDomain,
    },
  }
}

export function previewDeployCommand(configPath: string, node: string) {
  if (!isAbsolute(configPath) || !isAbsolute(node)) throw new Error("Preview deploy command requires absolute paths")
  return [node, join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", `--config=${configPath}`]
}

export function previewAccessApplicationPayload() {
  return {
    name: "MongolGPT owner dev preview",
    domain: hostname,
    type: "self_hosted",
    session_duration: "4h",
    allow_authenticate_via_warp: false,
    allow_iframe: false,
    app_launcher_visible: false,
    enable_binding_cookie: true,
    http_only_cookie_attribute: true,
    options_preflight_bypass: false,
    same_site_cookie_attribute: "lax",
    mfa_config: mfaConfig,
    policies: [previewAccessPolicyPayload()],
  }
}

export function previewAccessPolicyPayload() {
  return {
    name: "MongolGPT owner dev preview",
    decision: "allow",
    precedence: 1,
    include: [{ email: { email: ownerEmail } }],
    exclude: [],
    require: [],
    mfa_config: mfaConfig,
  }
}

export async function ensurePreviewAccessApplication(token: string, request: Requester = fetch, readOnly = false) {
  const organization = await cloudflareAccess(token, "access/organizations", {}, request)
  if (!record(organization.result) || typeof organization.result.auth_domain !== "string")
    throw new Error("Preview Access organization is invalid")
  const teamDomain = normalizeTeamDomain(organization.result.auth_domain)
  const applications = await cloudflareAccess(
    token,
    `access/apps?domain=${encodeURIComponent(hostname)}&per_page=10`,
    {},
    request,
  )
  if (!Array.isArray(applications.result)) throw new Error("Preview Access application list is invalid")
  const matches = applications.result.filter(
    (value): value is Record<string, unknown> => record(value) && value.domain === hostname,
  )
  if (matches.length > 1) throw new Error("Preview Access hostname has multiple applications")
  if (readOnly && !matches.length) throw new Error("Preview Access application is missing")
  const application =
    matches[0] ??
    (
      await cloudflareAccess(
        token,
        "access/apps",
        { method: "POST", body: JSON.stringify(previewAccessApplicationPayload()) },
        request,
      )
    ).result
  if (!record(application)) throw new Error("Preview Access application response is invalid")
  const access = verifyPreviewAccessApplication(application)
  const policies = await cloudflareAccess(
    token,
    `access/apps/${encodeURIComponent(access.id)}/policies?per_page=10`,
    {},
    request,
  )
  if (!Array.isArray(policies.result) || policies.result.length !== 1 || !record(policies.result[0]))
    throw new Error("Preview Access application must have exactly one owner allow policy")
  verifyPreviewAccessPolicy(policies.result[0])
  return { id: access.id, aud: access.aud, teamDomain }
}

export function verifyPreviewAccessApplication(application: Record<string, unknown>) {
  const checks = [
    ["name", application.name === "MongolGPT owner dev preview"],
    ["domain", application.domain === hostname],
    ["type", application.type === "self_hosted"],
    ["session_duration", application.session_duration === "4h"],
    ["allow_authenticate_via_warp", application.allow_authenticate_via_warp === false],
    ["allow_iframe", application.allow_iframe === false || !Object.hasOwn(application, "allow_iframe")],
    ["app_launcher_visible", application.app_launcher_visible === false],
    ["enable_binding_cookie", application.enable_binding_cookie === true],
    ["http_only_cookie_attribute", application.http_only_cookie_attribute === true],
    ["options_preflight_bypass", application.options_preflight_bypass === false],
    ["same_site_cookie_attribute", application.same_site_cookie_attribute === "lax"],
    ["mfa_config", hasExactMfa(application.mfa_config)],
    ["id", typeof application.id === "string" && /^[0-9a-f-]{32,36}$/i.test(application.id)],
    ["aud", typeof application.aud === "string" && /^[a-f0-9]{64}$/.test(application.aud)],
  ] as const
  const failed = checks.filter(([, valid]) => !valid).map(([name]) => name)
  if (failed.length) throw new Error(`Preview Access application mismatch: ${failed.join(", ")}`)
  return { id: String(application.id), aud: String(application.aud).trim() }
}

export function verifyPreviewAccessPolicy(policy: Record<string, unknown>) {
  const includes = Array.isArray(policy.include)
    ? policy.include
    : Array.isArray(policy.includes)
      ? policy.includes
      : []
  const emails = includes.flatMap((value) => {
    if (!record(value) || !record(value.email) || typeof value.email.email !== "string") return []
    return [value.email.email.trim().toLowerCase()]
  })
  const excluded = Array.isArray(policy.exclude) ? policy.exclude : []
  const required = Array.isArray(policy.require) ? policy.require : []
  if (
    policy.name !== "MongolGPT owner dev preview" ||
    policy.decision !== "allow" ||
    policy.precedence !== 1 ||
    excluded.length ||
    required.length ||
    includes.length !== 1 ||
    !record(includes[0]) ||
    Object.keys(includes[0]).length !== 1 ||
    emails.length !== 1 ||
    emails[0] !== ownerEmail ||
    !hasExactMfa(policy.mfa_config)
  )
    throw new Error("Preview Access owner policy mismatch")
}

export async function inspectPreviewIngress(token: string, request: Requester = fetch) {
  const domains = await cloudflareDeploy(
    token,
    `accounts/${accountID}/workers/domains?hostname=${hostname}&per_page=10`,
    request,
  )
  if (!Array.isArray(domains.result)) throw new Error("Preview custom domain list is invalid")
  const matchingDomains = domains.result.filter((value): value is Record<string, unknown> => {
    if (!record(value)) return false
    return value.hostname === hostname || value.domain === hostname || value.name === hostname
  })
  const zones = await cloudflareDeploy(
    token,
    `zones?name=${rootZone}&account.id=${accountID}&status=active&per_page=5`,
    request,
  )
  if (!Array.isArray(zones.result) || zones.result.length !== 1 || !record(zones.result[0]))
    throw new Error("Preview root zone could not be verified")
  const zoneID = String(zones.result[0].id ?? "")
  if (!/^[0-9a-f]{32}$/i.test(zoneID)) throw new Error("Preview root zone ID is invalid")
  const records = await cloudflareDeploy(
    token,
    `zones/${encodeURIComponent(zoneID)}/dns_records?name=${hostname}&per_page=10`,
    request,
  )
  if (!Array.isArray(records.result)) throw new Error("Preview DNS record list is invalid")
  const routes = await cloudflareDeploy(
    token,
    `zones/${encodeURIComponent(zoneID)}/workers/routes?per_page=100`,
    request,
  )
  if (!Array.isArray(routes.result)) throw new Error("Preview route list is invalid")
  return verifyPreviewIngress({
    domains: matchingDomains,
    dnsRecords: records.result.filter(record),
    routes: routes.result.filter(record),
  })
}

export function verifyPreviewIngress(input: {
  domains: Record<string, unknown>[]
  dnsRecords: Record<string, unknown>[]
  routes: Record<string, unknown>[]
}) {
  const ownedDomain = input.domains.find((domain) => domainOwner(domain) === workerName)
  if (input.domains.some((domain) => domainOwner(domain) !== workerName))
    throw new Error("Preview hostname is already owned by another Worker custom domain")
  if (!ownedDomain && input.dnsRecords.length) throw new Error("Preview hostname already has DNS records")
  if (input.routes.some((route) => routeMatchesHost(route, hostname) && routeOwner(route) !== workerName))
    throw new Error("Preview hostname is already owned by another Worker route")
  return { publicProtectedDomain: ownedDomain ? hostname : "pending" }
}

async function deploy() {
  if (process.platform !== "linux" || process.argv.length !== 2) throw new Error("Owner dev preview requires Linux CI")
  const identity = previewDeployContext(process.env)
  if (process.env.MONGOLGPT_PREVIEW_VERIFY_ONLY === "true") {
    console.log("PREVIEW_PHASE read_only_candidate")
    await verify()
    await verifyDeployedPreview()
    console.log("Existing owner preview boundaries verified without deployment; browser acceptance was not performed.")
    return
  }
  const node = Bun.which("node")
  if (!node) throw new Error("Pinned Node runtime is missing")
  if (!(await Bun.file(join(root, "../app/dist/index.html")).exists())) throw new Error("Preview app build is missing")
  if (!(await Bun.file(join(root, "../console/admin/src/preview/worker.ts")).exists()))
    throw new Error("Preview Worker entry is missing")

  console.log("PREVIEW_PHASE candidate_before")
  const before = await verify()
  console.log("PREVIEW_PHASE ingress_preflight")
  await inspectPreviewIngress(process.env.CLOUDFLARE_API_TOKEN!)
  await inspectPreviewWorker(process.env.CLOUDFLARE_API_TOKEN!, true)
  console.log("PREVIEW_PHASE access")
  const access = await ensurePreviewAccessApplication(process.env.CLOUDFLARE_ACCESS_API_TOKEN!)
  const folder = await mkdtemp(join(process.env.RUNNER_TEMP!, "mongolgpt-preview-dev-"))
  await chmod(folder, 0o700)
  try {
    const configPath = join(folder, "wrangler.json")
    await writeFile(
      configPath,
      JSON.stringify(previewWranglerConfig({ accessAudience: access.aud, accessTeamDomain: access.teamDomain })),
      { mode: 0o600, flag: "wx" },
    )
    console.log("PREVIEW_PHASE deploy")
    await runCandidateCommand(previewDeployCommand(configPath, node), 900_000)
    console.log("PREVIEW_PHASE candidate_after")
    const after = await verify()
    if (before.namespaceID !== after.namespaceID) throw new Error("Candidate namespace changed during preview deploy")
    const ingress = await verifyDeployedPreview()
    await writeFile(
      identity.output,
      JSON.stringify(
        {
          run: identity.run,
          sha: identity.sourceCommit,
          worker: identity.worker,
          accessID: access.id,
          aud: access.aud,
          publicProtectedDomain: ingress.publicProtectedDomain === hostname,
          domain: hostname,
          namespaceID: after.namespaceID,
          noBrowserAcceptance: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    console.log("Owner-only dev preview deployed behind Cloudflare Access; browser acceptance was not performed.")
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

async function verifyDeployedPreview() {
  console.log("PREVIEW_PHASE verify_ingress")
  const ingress = await inspectPreviewIngress(process.env.CLOUDFLARE_API_TOKEN!)
  if (ingress.publicProtectedDomain !== hostname)
    throw new Error("Preview protected domain is missing after deployment")
  console.log("PREVIEW_PHASE verify_worker")
  await inspectPreviewWorker(process.env.CLOUDFLARE_API_TOKEN!, false)
  console.log("PREVIEW_PHASE verify_access")
  const access = await ensurePreviewAccessApplication(process.env.CLOUDFLARE_ACCESS_API_TOKEN!, fetch, true)
  console.log("PREVIEW_PHASE verify_anonymous")
  for (const path of ["/", "/api/session", "/assets/__preview_boundary__.js"]) {
    const response = await fetch(`https://${hostname}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
    const location = response.headers.get("Location")
    void response.body?.cancel()
    if (response.status !== 302 || !location || new URL(location).origin !== access.teamDomain)
      throw new Error("Preview anonymous Access boundary failed")
  }
  return ingress
}

async function cloudflareAccess(token: string, path: string, init: RequestInit, request: Requester) {
  return cloudflareRequest(`https://api.cloudflare.com/client/v4/accounts/${accountID}/${path}`, token, init, request)
}

async function cloudflareDeploy(token: string, path: string, request: Requester) {
  return cloudflareRequest(`https://api.cloudflare.com/client/v4/${path}`, token, {}, request)
}

async function cloudflareRequest(
  url: string,
  token: string,
  init: RequestInit,
  request: Requester,
  allowMissing = false,
) {
  const response = await request(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.headers.get("content-type")?.startsWith("application/json") || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error("Cloudflare API response is invalid")
  }
  const value: unknown = JSON.parse(await boundedText(response.body, maxResponseBytes))
  if (allowMissing && response.status === 404 && record(value) && value.success === false) return { notFound: true }
  if (!response.ok || !record(value) || value.success !== true)
    throw new Error(`Cloudflare API request failed: ${response.status}`)
  if (
    record(value.result_info) &&
    typeof value.result_info.total_pages === "number" &&
    value.result_info.total_pages > 1
  )
    throw new Error("Cloudflare pagination exceeds preview scope")
  return value
}

async function inspectPreviewWorker(token: string, allowMissing: boolean) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountID}/workers/scripts/${workerName}`
  const settings = await cloudflareRequest(`${base}/settings`, token, {}, fetch, allowMissing)
  if (settings.notFound === true && allowMissing) return
  const subdomain = await cloudflareRequest(`${base}/subdomain`, token, {}, fetch)
  if (record(settings.result) && Array.isArray(settings.result.bindings) && record(subdomain.result))
    console.log(
      "PREVIEW_METADATA",
      JSON.stringify({
        bindings: settings.result.bindings.filter(record).map((value) => ({ name: value.name, type: value.type })),
        enabled: subdomain.result.enabled,
        previews_enabled: subdomain.result.previews_enabled,
      }),
    )
  verifyPreviewWorker(settings.result, subdomain.result)
}

export function verifyPreviewWorker(settings: unknown, subdomain: unknown) {
  if (
    !record(settings) ||
    !Array.isArray(settings.bindings) ||
    !record(subdomain) ||
    subdomain.enabled !== false ||
    subdomain.previews_enabled !== false
  )
    throw new Error("Preview Worker ingress is unverified")
  const bindings = settings.bindings.filter(record)
  const service = bindings.filter((value) => value.type === "service")
  const stage = bindings.find((value) => value.name === "STAGE")
  const audience = bindings.find((value) => value.name === "ACCESS_AUDIENCE")
  const team = bindings.find((value) => value.name === "ACCESS_TEAM_DOMAIN")
  if (
    bindings.length !== 5 ||
    service.length !== 1 ||
    service[0].name !== "CANDIDATE" ||
    service[0].service !== candidate.name ||
    stage?.type !== "plain_text" ||
    stage.text !== "dev" ||
    audience?.type !== "plain_text" ||
    typeof audience.text !== "string" ||
    !/^[a-f0-9]{64}$/.test(audience.text) ||
    team?.type !== "plain_text" ||
    team.text !== "https://raspy-frog-02f6.cloudflareaccess.com" ||
    !bindings.some((value) => value.name === "ASSETS" && value.type === "assets")
  )
    throw new Error("Preview Worker bindings are unverified")
}

async function boundedText(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return Buffer.concat(chunks).toString("utf8")
      size += next.value.byteLength
      if (size > limit) throw new Error("Cloudflare response exceeded its bound")
      chunks.push(next.value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function hasExactMfa(value: unknown) {
  if (!record(value) || value.mfa_disabled !== false || value.session_duration !== "1h") return false
  const allowed = Array.isArray(value.allowed_authenticators)
    ? value.allowed_authenticators.filter((item): item is string => typeof item === "string")
    : []
  return sameStrings(allowed, mfaConfig.allowed_authenticators)
}

function sameStrings(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const sortedRight = [...right].sort()
  return [...left].sort().every((value, index) => value === sortedRight[index])
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
  )
    throw new Error("Preview Access team domain is invalid")
  return url.origin
}

function domainOwner(domain: Record<string, unknown>) {
  for (const key of ["service", "service_name", "script", "script_name"]) {
    if (typeof domain[key] === "string") return domain[key]
  }
  return ""
}

function routeOwner(route: Record<string, unknown>) {
  for (const key of ["script", "script_name", "service", "service_name"]) {
    if (typeof route[key] === "string") return route[key]
  }
  return ""
}

function routeMatchesHost(route: Record<string, unknown>, target: string) {
  const pattern = typeof route.pattern === "string" ? route.pattern : ""
  const host = pattern
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
  if (host === target) return true
  if (!host.startsWith("*.")) return false
  return target.endsWith(host.slice(1))
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

if (import.meta.main)
  deploy().catch((error: unknown) => {
    const known = [
      "Owner dev preview requires Linux CI",
      "Owner dev preview context is invalid",
      "Pinned Node runtime is missing",
      "Preview app build is missing",
      "Preview Worker entry is missing",
      "Preview Access organization is invalid",
      "Preview Access application list is invalid",
      "Preview Access hostname has multiple applications",
      "Preview Access application response is invalid",
      "Preview Access application is missing",
      "Preview Access application must have exactly one owner allow policy",
      "Preview Access owner policy mismatch",
      "Preview root zone could not be verified",
      "Preview root zone ID is invalid",
      "Preview custom domain list is invalid",
      "Preview DNS record list is invalid",
      "Preview route list is invalid",
      "Preview hostname is already owned by another Worker custom domain",
      "Preview hostname already has DNS records",
      "Preview hostname is already owned by another Worker route",
      "Candidate namespace changed during preview deploy",
      "Preview protected domain is missing after deployment",
      "Preview Worker ingress is unverified",
      "Preview Worker bindings are unverified",
      "Preview anonymous Access boundary failed",
      "Cloudflare pagination exceeds preview scope",
    ]
    if (
      error instanceof Error &&
      (known.includes(error.message) ||
        error.message.startsWith("Preview Access application mismatch:") ||
        /^Cloudflare API request failed: \d{3}$/.test(error.message))
    )
      console.error(error.message)
    console.error("Owner dev preview deploy failed; private Cloudflare output was not logged.")
    process.exitCode = 1
  })
