import { productServiceUrls, resolveProductServiceUrls } from "@mongolgpt/core/product"
import { BlockList, isIP } from "node:net"

const blockedAddresses = new BlockList()

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4")
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6")
}

const canonicalHostname = (url: URL) =>
  url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")

export const isLoopbackAccountServer = (input: string | URL) => {
  const url = typeof input === "string" ? new URL(input) : input
  const hostname = canonicalHostname(url)
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname)
}

export const isBlockedAccountAddress = (address: string) => {
  const family = isIP(address)
  if (family === 4) return blockedAddresses.check(address, "ipv4")
  if (family === 6) return blockedAddresses.check(address, "ipv6")
  return true
}

const validateHttpUrl = (input: string) => {
  const url = new URL(input)
  if (url.username || url.password) throw new Error("Account серверийн URL нэвтрэх мэдээлэл агуулж болохгүй")

  if (url.protocol === "http:" && isLoopbackAccountServer(url)) return url
  if (url.protocol !== "https:") throw new Error("Account сервер HTTPS ашиглах ёстой")

  const hostname = canonicalHostname(url)
  if (hostname.length === 0 || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Account серверийн hostname нийтэд хандах боломжтой байх ёстой")
  }
  if (isIP(hostname) && isBlockedAccountAddress(hostname)) {
    throw new Error("Account сервер private эсвэл reserved IP ашиглаж болохгүй")
  }
  return url
}

export const normalizeServerUrl = (input: string): string => {
  const url = new URL(input)
  url.search = ""
  url.hash = ""

  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname.length === 0 || accountUiPaths.has(pathname)) return url.origin
  return `${url.origin}${pathname}`
}

export const defaultConsoleUrl = process.env.MONGOLGPT_CONSOLE_URL?.trim() || productServiceUrls.console
export const defaultAuthUrl = process.env.MONGOLGPT_AUTH_URL?.trim() || productServiceUrls.auth

const accountServerIdentity = (url: URL) => {
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  return `${url.protocol}//${canonicalHostname(url)}:${port}`
}

const configuredAccountServers = () => [
  defaultConsoleUrl,
  defaultAuthUrl,
  resolveProductServiceUrls("prod").console,
  resolveProductServiceUrls("prod").auth,
  resolveProductServiceUrls("beta").console,
  resolveProductServiceUrls("beta").auth,
]

const hostedAccountServices = () => [resolveProductServiceUrls("prod"), resolveProductServiceUrls("beta")]

const accountUiPaths = new Set(["/auth", "/console", "/workspace"])

export const resolveAuthServerUrl = (input: string): string => {
  const override = process.env.MONGOLGPT_AUTH_URL
  if (override) return normalizeServerUrl(override)

  const url = new URL(input)
  url.search = ""
  url.hash = ""

  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname.startsWith("/auth")) return pathname.length === 0 ? url.origin : `${url.origin}${pathname}`
  if (url.hostname.startsWith("auth.")) return pathname.length === 0 ? url.origin : `${url.origin}${pathname}`

  const hosted = hostedAccountServices().find(
    (services) => normalizeServerUrl(input) === normalizeServerUrl(services.console),
  )
  if (hosted) return hosted.auth

  if (normalizeServerUrl(input) === normalizeServerUrl(defaultConsoleUrl)) return defaultAuthUrl

  return normalizeServerUrl(input)
}

export const validateAccountServerUrl = (input: string) => {
  validateHttpUrl(input)
  return normalizeServerUrl(input)
}

export const resolveAccountVerificationUrl = (server: string, input: string) => {
  if (!input.trim()) throw new Error("OAuth verification URL хоосон байж болохгүй")

  const base = validateHttpUrl(`${validateAccountServerUrl(server)}/`)
  const target = validateHttpUrl(new URL(input, base).toString())
  if (target.origin !== base.origin) {
    throw new Error("OAuth verification URL account сервертэй ижил origin ашиглах ёстой")
  }
  return target.toString()
}

export const validateConfiguredAccountServerUrl = (input: string) => {
  const normalized = validateAccountServerUrl(input)
  if (isLoopbackAccountServer(normalized)) return normalized

  const identity = accountServerIdentity(new URL(normalized))
  const trusted = configuredAccountServers().some((candidate) => {
    try {
      return accountServerIdentity(validateHttpUrl(candidate)) === identity
    } catch {
      return false
    }
  })
  if (!trusted) throw new Error("Account сервер MongolGPT-ийн тохируулсан албан ёсны хаяг биш байна")
  return normalized
}

export const validateAccountOAuthMetadata = (
  expectedIssuer: string,
  metadata: { issuer: string; authorization_endpoint: string; token_endpoint: string },
) => {
  const expected = validateHttpUrl(expectedIssuer)
  const issuer = validateHttpUrl(metadata.issuer)
  const authorization = validateHttpUrl(metadata.authorization_endpoint)
  const token = validateHttpUrl(metadata.token_endpoint)
  const identity = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, "")}`

  if (issuer.search || issuer.hash || identity(issuer) !== identity(expected)) {
    throw new Error("OAuth issuer хүлээгдэж буй account auth сервертэй тохирохгүй байна")
  }
  if (authorization.origin !== issuer.origin || token.origin !== issuer.origin) {
    throw new Error("OAuth endpoint-үүд issuer-тэй ижил origin ашиглах ёстой")
  }
}
