const HEADER = { alg: "HS256", typ: "JWT" } as const
const MIN_SECRET_LENGTH = 32
const MIN_TTL_SECONDS = 60
const MAX_TTL_SECONDS = 120
const MAX_FUTURE_IAT_SECONDS = 5
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export const runtimeGatewayHeader = "x-mongolgpt-runtime-gateway-token"

export type RuntimeCapability = {
  sub: string
  workspaceID: string
  authVersion: number
  aud: string
  iat: number
  exp: number
  jti: string
  v: 1
}

export type IssueRuntimeCapabilityInput = {
  accountID: string
  workspaceID: string
  authVersion: number
  audience: string
  secret: string
  ttlSeconds?: number
  now?: number
  jti?: string
}

export type VerifyRuntimeCapabilityInput = {
  token: string
  audience: string
  secret: string
  now?: number
}

export class RuntimeCapabilityError extends Error {
  constructor() {
    super("Invalid runtime capability")
    this.name = "RuntimeCapabilityError"
  }
}

export async function issueRuntimeCapability(input: IssueRuntimeCapabilityInput): Promise<string> {
  const secret = requireSecret(input.secret)
  const ttlSeconds = input.ttlSeconds ?? 90
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    throw invalidCapability()
  }

  const now = clock(input.now)
  const capability: RuntimeCapability = {
    sub: accountID(input.accountID),
    workspaceID: workspaceID(input.workspaceID),
    authVersion: authVersion(input.authVersion),
    aud: runtimeAudience(input.audience),
    iat: now,
    exp: now + ttlSeconds,
    jti: runtimeJTI(input.jti),
    v: 1,
  }
  const header = encodeJSON(HEADER)
  const payload = encodeJSON(capability)
  const signingInput = `${header}.${payload}`
  const signature = encodeBase64Url(await sign(signingInput, secret))
  return `${signingInput}.${signature}`
}

export async function verifyRuntimeCapability(input: VerifyRuntimeCapabilityInput): Promise<RuntimeCapability> {
  try {
    const secret = requireSecret(input.secret)
    const audience = runtimeAudience(input.audience)
    const [encodedHeader, encodedPayload, encodedSignature] = compactToken(input.token)
    const header = parseJSON(encodedHeader)
    if (!validHeader(header)) throw invalidCapability()

    const signature = decodeBase64Url(encodedSignature)
    const verified = await crypto.subtle.verify(
      "HMAC",
      await key(secret, ["verify"]),
      signature,
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
    )
    if (!verified) throw invalidCapability()

    const capability = capabilityClaims(parseJSON(encodedPayload))
    const now = clock(input.now)
    if (capability.aud !== audience) throw invalidCapability()
    if (capability.exp <= now) throw invalidCapability()
    if (capability.iat > now + MAX_FUTURE_IAT_SECONDS) throw invalidCapability()
    if (capability.exp - capability.iat < MIN_TTL_SECONDS) throw invalidCapability()
    if (capability.exp - capability.iat > MAX_TTL_SECONDS) throw invalidCapability()
    return capability
  } catch (error) {
    if (error instanceof RuntimeCapabilityError) throw error
    throw invalidCapability()
  }
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || Array.from(value).length < MIN_SECRET_LENGTH) throw invalidCapability()
  return value
}

function clock(value: unknown): number {
  const now = value ?? Math.floor(Date.now() / 1000)
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) throw invalidCapability()
  return now
}

function accountID(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value)
    throw invalidCapability()
  return value
}

function workspaceID(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 5 ||
    value.length > 30 ||
    value.trim() !== value ||
    !value.startsWith("wrk_")
  ) {
    throw invalidCapability()
  }
  return value
}

function authVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidCapability()
  return value
}

function runtimeAudience(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw invalidCapability()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidCapability()
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw invalidCapability()
  }
  return url.origin
}

function runtimeJTI(value: unknown): string {
  if (value === undefined) {
    const bytes = new Uint8Array(18)
    crypto.getRandomValues(bytes)
    return encodeBase64Url(bytes)
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw invalidCapability()
  return value
}

function compactToken(value: unknown): [string, string, string] {
  if (typeof value !== "string") throw invalidCapability()
  const parts = value.split(".")
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw invalidCapability()
  return [parts[0]!, parts[1]!, parts[2]!]
}

function validHeader(value: unknown): value is typeof HEADER {
  return (
    object(value) &&
    Object.keys(value).length === 2 &&
    value.alg === HEADER.alg &&
    value.typ === HEADER.typ &&
    Object.prototype.hasOwnProperty.call(value, "alg") &&
    Object.prototype.hasOwnProperty.call(value, "typ")
  )
}

function capabilityClaims(value: unknown): RuntimeCapability {
  if (!object(value) || Object.keys(value).length !== 8) throw invalidCapability()
  const capability = value
  if (
    !Object.prototype.hasOwnProperty.call(capability, "sub") ||
    !Object.prototype.hasOwnProperty.call(capability, "workspaceID") ||
    !Object.prototype.hasOwnProperty.call(capability, "authVersion") ||
    !Object.prototype.hasOwnProperty.call(capability, "aud") ||
    !Object.prototype.hasOwnProperty.call(capability, "iat") ||
    !Object.prototype.hasOwnProperty.call(capability, "exp") ||
    !Object.prototype.hasOwnProperty.call(capability, "jti") ||
    !Object.prototype.hasOwnProperty.call(capability, "v") ||
    capability.v !== 1
  ) {
    throw invalidCapability()
  }
  const issuedAt = clock(capability.iat)
  const expiresAt = clock(capability.exp)
  if (expiresAt <= issuedAt) throw invalidCapability()
  return {
    sub: accountID(capability.sub),
    workspaceID: workspaceID(capability.workspaceID),
    authVersion: authVersion(capability.authVersion),
    aud: runtimeAudience(capability.aud),
    iat: issuedAt,
    exp: expiresAt,
    jti: runtimeJTI(capability.jti),
    v: 1,
  }
}

async function sign(value: string, secret: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), encoder.encode(value)))
}

function key(secret: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages)
}

function encodeJSON(value: unknown): string {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)))
}

function parseJSON(value: string): unknown {
  try {
    return JSON.parse(decoder.decode(decodeBase64Url(value)))
  } catch {
    throw invalidCapability()
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < value.length; index += 0x8000) {
    binary += String.fromCharCode(...value.subarray(index, index + 0x8000))
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw invalidCapability()
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    if (encodeBase64Url(bytes) !== value) throw invalidCapability()
    return bytes
  } catch (error) {
    if (error instanceof RuntimeCapabilityError) throw error
    throw invalidCapability()
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidCapability(): RuntimeCapabilityError {
  return new RuntimeCapabilityError()
}
