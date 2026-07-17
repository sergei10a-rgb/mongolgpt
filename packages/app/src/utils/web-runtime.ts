export type WebRuntime = {
  mode: "local-bridge" | "hosted"
  serverUrl: string
}

type ResolveWebRuntimeInput = {
  dev: boolean
  origin: string
  serverHost?: string
  serverPort?: string
  serverUrl?: string
}

function normalizeHttpUrl(input: string) {
  const url = new URL(input.trim())
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MongolGPT runtime URL must use http or https")
  }
  return url.toString().replace(/\/+$/, "")
}

function isLoopback(url: string) {
  const hostname = new URL(url).hostname
  return hostname === "localhost" || hostname === "127.0.0.1"
}

export function resolveWebRuntime(input: ResolveWebRuntimeInput): WebRuntime {
  void input.origin
  const configured = input.serverUrl?.trim()
  const serverUrl = configured
    ? normalizeHttpUrl(configured)
    : input.dev
      ? normalizeHttpUrl(`http://${input.serverHost || "localhost"}:${input.serverPort || "4096"}`)
      : "http://localhost:4096"

  return {
    mode: isLoopback(serverUrl) ? "local-bridge" : "hosted",
    serverUrl,
  }
}

export function resolveDefaultServerUrl(input: { runtime: WebRuntime; storedUrl: string | null; appOrigin: string }) {
  if (!input.storedUrl) {
    return {
      url: input.runtime.serverUrl,
      clearStored: false,
    }
  }

  let storedUrl: string
  try {
    storedUrl = normalizeHttpUrl(input.storedUrl)
  } catch {
    return {
      url: input.runtime.serverUrl,
      clearStored: true,
    }
  }

  const appOrigin = normalizeHttpUrl(input.appOrigin)
  if (storedUrl === appOrigin) {
    return {
      url: input.runtime.serverUrl,
      clearStored: true,
    }
  }

  return {
    url: storedUrl,
    clearStored: false,
  }
}
