import {
  createLocalBridgePairing,
  parseLocalBridgeCallback,
  type LocalBridgePairingRequest,
} from "@mongolgpt/local-bridge"

const STORAGE_KEY = "mongolgpt.local-bridge.pending-v1"
const PENDING_TTL_MS = 10 * 60 * 1000
const BRIDGE_USERNAME = "bridge"
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

type BridgeFetchInit = RequestInit & {
  targetAddressSpace?: "loopback"
}

type BridgeFetch = (input: RequestInfo | URL, init?: BridgeFetchInit) => Promise<Response>

export type LocalBridgeClientDependencies = {
  origin: string
  now?: () => number
  storage: BrowserStorage
  replaceURL: (url: string) => void
  launchDesktop: (url: string) => void | Promise<void>
  fetch?: BridgeFetch
}

export type LocalBridgeConnection = {
  url: string
  username: "bridge"
  password: string
  accountID: string
  expiresAt: number
}

export class LocalBridgeClientError extends Error {
  constructor(message = "MongolGPT-ийн локал холболтыг дуусгаж чадсангүй") {
    super(message)
    this.name = "LocalBridgeClientError"
  }
}

type PendingPairing = {
  verifier: string
  state: string
  accountID: string
  expiresAt: number
}

type ExchangeResponse = {
  authenticated: true
  username: "bridge"
  token: string
  accountID: string
  expiresAt: number
}

export function createLocalBridgeClient(dependencies: LocalBridgeClientDependencies) {
  const now = dependencies.now ?? Date.now
  const requestFetch = dependencies.fetch ?? ((input, init) => fetch(input, init))

  const begin = async (accountID: string) => {
    const pairing = await createLocalBridgePairing({
      origin: dependencies.origin,
      accountID,
    })
    const pending: PendingPairing = {
      verifier: pairing.verifier,
      state: pairing.request.state,
      accountID: pairing.request.accountID,
      expiresAt: now() + PENDING_TTL_MS,
    }
    writePending(dependencies.storage, pending)
    await dependencies.launchDesktop(pairing.url)
    return { expiresAt: pending.expiresAt }
  }

  const callback = async (currentURL: string): Promise<LocalBridgeConnection> => {
    let parsed: ReturnType<typeof parseLocalBridgeCallback>
    try {
      parsed = parseLocalBridgeCallback(currentURL, dependencies.origin)
    } catch {
      throw new LocalBridgeClientError("Локал холболтын хариу буруу байна")
    }

    const pending = readPending(dependencies.storage)
    if (!pending) {
      clearCallbackURL(dependencies.replaceURL, currentURL)
      throw new LocalBridgeClientError("Идэвхтэй локал холболтын хүсэлт алга байна")
    }

    if (parsed.state !== pending.state) {
      clearCallbackURL(dependencies.replaceURL, currentURL)
      throw new LocalBridgeClientError("Локал холболтын төлөв таарахгүй байна")
    }
    if (parsed.origin !== dependencies.origin || pending.accountID.length === 0) {
      clearPending(dependencies.storage, dependencies.replaceURL, currentURL)
      throw new LocalBridgeClientError("Локал холболтын бүртгэл таарахгүй байна")
    }
    if (pending.expiresAt <= now()) {
      clearPending(dependencies.storage, dependencies.replaceURL, currentURL)
      throw new LocalBridgeClientError("Локал холболтын хүсэлтийн хугацаа дууссан байна")
    }

    // Remove the verifier before touching the local service so it cannot be replayed.
    clearPending(dependencies.storage, dependencies.replaceURL, currentURL)

    let response: Response
    try {
      response = await requestFetch(`http://127.0.0.1:${parsed.port}/bridge/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: parsed.code, verifier: pending.verifier }),
        targetAddressSpace: "loopback",
      })
    } catch {
      throw new LocalBridgeClientError("Локал холболтын үйлчилгээ хариу өгсөнгүй")
    }

    if (response.status !== 200 || !isJSONResponse(response)) {
      throw new LocalBridgeClientError("Локал холболтын үйлчилгээ хүсэлтийг зөвшөөрсөнгүй")
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new LocalBridgeClientError("Локал холболтын үйлчилгээний хариу буруу байна")
    }
    if (!isExchangeResponse(body, now()) || body.accountID !== pending.accountID) {
      throw new LocalBridgeClientError("Локал холболтын бүртгэл таарахгүй байна")
    }

    return {
      url: `http://127.0.0.1:${parsed.port}`,
      username: BRIDGE_USERNAME,
      password: body.token,
      accountID: body.accountID,
      expiresAt: body.expiresAt,
    }
  }

  return { begin, callback }
}

function readPending(storage: BrowserStorage): PendingPairing | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null")
    if (!isPendingPairing(value)) return undefined
    return value
  } catch {
    return undefined
  }
}

function writePending(storage: BrowserStorage, pending: PendingPairing) {
  storage.setItem(STORAGE_KEY, JSON.stringify(pending))
}

function clearPending(storage: BrowserStorage, replaceURL: (url: string) => void, currentURL: string) {
  storage.removeItem(STORAGE_KEY)
  clearCallbackURL(replaceURL, currentURL)
}

function clearCallbackURL(replaceURL: (url: string) => void, currentURL: string) {
  try {
    const url = new URL(currentURL)
    url.hash = ""
    replaceURL(url.toString())
  } catch {
    replaceURL(currentURL.split("#", 1)[0])
  }
}

export function isLocalBridgeCallback(currentURL: string, origin: string) {
  try {
    parseLocalBridgeCallback(currentURL, origin)
    return true
  } catch {
    return false
  }
}

export function createBrowserLocalBridgeClient() {
  return createLocalBridgeClient({
    origin: window.location.origin,
    storage: window.localStorage,
    replaceURL: (url) => window.history.replaceState(null, "", url),
    launchDesktop: (url) => {
      const link = document.createElement("a")
      link.href = url
      link.hidden = true
      document.body.append(link)
      link.click()
      link.remove()
    },
  })
}

function isJSONResponse(response: Response) {
  return (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() === "application/json"
}

function isPendingPairing(value: unknown): value is PendingPairing {
  return (
    object(value) &&
    typeof value.verifier === "string" &&
    TOKEN_PATTERN.test(value.verifier) &&
    typeof value.state === "string" &&
    TOKEN_PATTERN.test(value.state) &&
    typeof value.accountID === "string" &&
    value.accountID.length > 0 &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt)
  )
}

function isExchangeResponse(value: unknown, currentTime: number): value is ExchangeResponse {
  return (
    object(value) &&
    exactKeys(value, ["authenticated", "username", "token", "accountID", "expiresAt"]) &&
    value.authenticated === true &&
    value.username === BRIDGE_USERNAME &&
    typeof value.token === "string" &&
    TOKEN_PATTERN.test(value.token) &&
    typeof value.accountID === "string" &&
    value.accountID.length > 0 &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > currentTime
  )
}

function object(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

export type { LocalBridgePairingRequest }
