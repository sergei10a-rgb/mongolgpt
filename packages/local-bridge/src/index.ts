const PAIRING_PROTOCOL_VERSION = "1"
const PAIRING_PROTOCOL = "mongolgpt:"
const PAIRING_HOST = "bridge"
const PAIRING_PATH = "/pair"
const CALLBACK_MARKER = "mongolgpt-bridge-v1"
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const encoder = new TextEncoder()

export type LocalBridgePairingRequest = {
  version: 1
  origin: string
  accountID: string
  state: string
  challenge: string
}

export type LocalBridgePairingCallback = {
  version: 1
  origin: string
  state: string
  port: number
  code: string
}

export type CreateLocalBridgePairingInput = {
  origin: string
  accountID: string
  randomBytes?: (length: number) => Uint8Array
}

export class LocalBridgeProtocolError extends Error {
  constructor() {
    super("Дотоод bridge pairing хүсэлт буруу байна")
    this.name = "LocalBridgeProtocolError"
  }
}

export async function createLocalBridgePairing(input: CreateLocalBridgePairingInput) {
  const origin = canonicalAppOrigin(input.origin)
  const accountID = requireAccountID(input.accountID)
  const random = input.randomBytes ?? secureRandomBytes
  const verifier = randomToken(random, 32)
  const request: LocalBridgePairingRequest = {
    version: 1,
    origin,
    accountID,
    state: randomToken(random, 32),
    challenge: await localBridgeChallenge(verifier),
  }
  return {
    verifier,
    request,
    url: localBridgePairingUrl(request),
  }
}

export function localBridgePairingUrl(input: LocalBridgePairingRequest) {
  const request = validatePairingRequest(input)
  const url = new URL(`${PAIRING_PROTOCOL}//${PAIRING_HOST}${PAIRING_PATH}`)
  url.searchParams.set("v", PAIRING_PROTOCOL_VERSION)
  url.searchParams.set("origin", request.origin)
  url.searchParams.set("account_id", request.accountID)
  url.searchParams.set("state", request.state)
  url.searchParams.set("challenge", request.challenge)
  return url.toString()
}

export function parseLocalBridgePairingUrl(
  value: string,
  allowedOrigins: readonly string[],
): LocalBridgePairingRequest {
  try {
    const url = new URL(value)
    if (url.protocol !== PAIRING_PROTOCOL || url.hostname !== PAIRING_HOST || url.pathname !== PAIRING_PATH) {
      throw invalidProtocol()
    }
    if (url.username || url.password || url.port || url.hash) throw invalidProtocol()
    requireExactKeys(url.searchParams, ["v", "origin", "account_id", "state", "challenge"])
    if (requiredParam(url.searchParams, "v") !== PAIRING_PROTOCOL_VERSION) throw invalidProtocol()

    const origin = canonicalAppOrigin(requiredParam(url.searchParams, "origin"))
    const allowed = new Set(allowedOrigins.map(canonicalAppOrigin))
    if (!allowed.size || !allowed.has(origin)) throw invalidProtocol()

    return validatePairingRequest({
      version: 1,
      origin,
      accountID: requiredParam(url.searchParams, "account_id"),
      state: requiredParam(url.searchParams, "state"),
      challenge: requiredParam(url.searchParams, "challenge"),
    })
  } catch (error) {
    if (error instanceof LocalBridgeProtocolError) throw error
    throw invalidProtocol()
  }
}

export async function localBridgeChallenge(verifier: string) {
  const value = requireToken(verifier)
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))))
}

export async function verifyLocalBridgeChallenge(verifier: string, challenge: string) {
  try {
    const expected = requireToken(challenge)
    const actual = await localBridgeChallenge(verifier)
    return constantTimeEqual(actual, expected)
  } catch {
    return false
  }
}

export function createLocalBridgeAuthorizationCode(randomBytes: (length: number) => Uint8Array = secureRandomBytes) {
  return randomToken(randomBytes, 32)
}

export function createLocalBridgeCallback(input: Omit<LocalBridgePairingCallback, "version">) {
  const callback = validatePairingCallback({ ...input, version: 1 })
  const url = new URL(callback.origin)
  const params = new URLSearchParams()
  params.set("bridge", CALLBACK_MARKER)
  params.set("state", callback.state)
  params.set("port", String(callback.port))
  params.set("code", callback.code)
  url.hash = params.toString()
  return url.toString()
}

export function parseLocalBridgeCallback(value: string, expectedOrigin: string): LocalBridgePairingCallback {
  try {
    const url = new URL(value)
    const origin = canonicalAppOrigin(expectedOrigin)
    if (url.origin !== origin) throw invalidProtocol()
    const params = new URLSearchParams(url.hash.slice(1))
    requireExactKeys(params, ["bridge", "state", "port", "code"])
    if (requiredParam(params, "bridge") !== CALLBACK_MARKER) throw invalidProtocol()
    const port = Number(requiredParam(params, "port"))
    return validatePairingCallback({
      version: 1,
      origin,
      state: requiredParam(params, "state"),
      port,
      code: requiredParam(params, "code"),
    })
  } catch (error) {
    if (error instanceof LocalBridgeProtocolError) throw error
    throw invalidProtocol()
  }
}

export function canonicalAppOrigin(value: string) {
  try {
    const url = new URL(value)
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw invalidProtocol()
    if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      throw invalidProtocol()
    }
    return url.origin
  } catch (error) {
    if (error instanceof LocalBridgeProtocolError) throw error
    throw invalidProtocol()
  }
}

function validatePairingRequest(input: LocalBridgePairingRequest): LocalBridgePairingRequest {
  if (input.version !== 1) throw invalidProtocol()
  return {
    version: 1,
    origin: canonicalAppOrigin(input.origin),
    accountID: requireAccountID(input.accountID),
    state: requireToken(input.state),
    challenge: requireToken(input.challenge),
  }
}

function validatePairingCallback(input: LocalBridgePairingCallback): LocalBridgePairingCallback {
  if (input.version !== 1 || !Number.isSafeInteger(input.port) || input.port < 1024 || input.port > 65_535) {
    throw invalidProtocol()
  }
  return {
    version: 1,
    origin: canonicalAppOrigin(input.origin),
    state: requireToken(input.state),
    port: input.port,
    code: requireToken(input.code),
  }
}

function requireAccountID(value: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidProtocol()
  }
  return value
}

function requireToken(value: string) {
  if (!TOKEN_PATTERN.test(value)) throw invalidProtocol()
  return value
}

function requiredParam(params: URLSearchParams, name: string) {
  const values = params.getAll(name)
  if (values.length !== 1 || !values[0]) throw invalidProtocol()
  return values[0]
}

function requireExactKeys(params: URLSearchParams, expected: readonly string[]) {
  const keys = [...params.keys()]
  if (keys.length !== expected.length || expected.some((name) => params.getAll(name).length !== 1)) {
    throw invalidProtocol()
  }
  if (keys.some((name) => !expected.includes(name))) throw invalidProtocol()
}

function secureRandomBytes(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function randomToken(randomBytes: (length: number) => Uint8Array, length: number) {
  const bytes = randomBytes(length)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw invalidProtocol()
  return encodeBase64Url(bytes)
}

function encodeBase64Url(value: Uint8Array) {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

function invalidProtocol() {
  return new LocalBridgeProtocolError()
}
