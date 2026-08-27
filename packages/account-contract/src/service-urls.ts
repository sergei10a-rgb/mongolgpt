export type HostedServiceUrls = ReturnType<typeof resolveHostedServiceUrls>

const stagePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function resolveHostedServiceUrls(rootDomainInput: string, stageInput: string) {
  const rootDomain = canonicalRootDomain(rootDomainInput)
  const stage = canonicalStage(stageInput)
  const stageDomain = stage === "production" ? rootDomain : `${stage}.${rootDomain}`
  const console = `https://${stageDomain}`

  return {
    rootDomain,
    stage,
    stageDomain,
    console,
    support: `${console}/support`,
    auth: `https://auth.${stageDomain}`,
    app: `https://app.${stageDomain}`,
    docs: `https://docs.${stageDomain}/docs`,
    runtime: `https://runtime.${stageDomain}`,
    payment: `https://pay.${stageDomain}`,
    admin: `https://admin.${stageDomain}`,
    share: `https://share.${stageDomain}`,
  } as const
}

export function isHostedAppOrigin(input: string, rootDomainInput: string) {
  const rootDomain = canonicalRootDomain(rootDomainInput)
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return false
  }
  if (url.protocol !== "https:" || url.origin !== input || url.port || url.username || url.password) return false
  if (input === resolveHostedServiceUrls(rootDomain, "production").app) return true

  const suffix = `.${rootDomain}`
  if (!url.hostname.endsWith(suffix)) return false
  const prefix = url.hostname.slice(0, -suffix.length).split(".")
  if (prefix.length !== 2 || prefix[0] !== "app") return false
  const stage = prefix[1]
  if (!stage) return false

  try {
    return input === resolveHostedServiceUrls(rootDomain, stage).app
  } catch {
    return false
  }
}

function canonicalRootDomain(input: string) {
  const value = input.trim().toLowerCase()
  if (value !== input || value.length > 253 || value.includes("..")) {
    throw new Error("MongolGPT root domain canonical жижиг үсгийн hostname байна.")
  }
  const labels = value.split(".")
  if (labels.length < 2 || labels.some((label) => !domainLabelPattern.test(label))) {
    throw new Error("MongolGPT root domain хүчинтэй hostname байна.")
  }
  return value
}

function canonicalStage(input: string) {
  if (input !== input.trim().toLowerCase() || !stagePattern.test(input)) {
    throw new Error("MongolGPT deployment stage canonical жижиг үсгийн label байна.")
  }
  return input
}
