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
    throw new Error("MongolGPT-ийн ажиллах орчны URL нь http эсвэл https протокол ашиглах ёстой")
  }
  return url.toString().replace(/\/+$/, "")
}

function isLoopback(url: string) {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "")
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  )
}

export function resolveWebRuntime(input: ResolveWebRuntimeInput): WebRuntime {
  const configured = input.serverUrl?.trim()
  const serverUrl = configured
    ? normalizeHttpUrl(configured)
    : input.dev
      ? normalizeHttpUrl(`http://${input.serverHost || "localhost"}:${input.serverPort || "4096"}`)
      : "http://localhost:4096"

  if (configured && new URL(serverUrl).origin === new URL(normalizeHttpUrl(input.origin)).origin) {
    throw new Error("MongolGPT-ийн веб аппын хаягийг API runtime болгон ашиглах боломжгүй")
  }

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
  if (new URL(storedUrl).origin === new URL(appOrigin).origin) {
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
