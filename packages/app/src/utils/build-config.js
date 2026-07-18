const channels = new Set(["dev", "beta", "prod"])

function httpUrl(input) {
  const value = input?.trim()
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MongolGPT runtime URL must use http or https")
  }
  return url.toString().replace(/\/+$/, "")
}

function local(url) {
  const hostname = new URL(url).hostname
  return hostname === "localhost" || hostname === "127.0.0.1"
}

export function resolveChannel(env = process.env) {
  const raw = env.MONGOLGPT_CHANNEL ?? env.VITE_MONGOLGPT_CHANNEL
  if (channels.has(raw)) return raw
  if (raw === "latest") return "prod"
  return "dev"
}

export function resolveRuntimeMetadata(env = process.env) {
  const host = env.VITE_MONGOLGPT_SERVER_HOST?.trim()
  const port = env.VITE_MONGOLGPT_SERVER_PORT?.trim() || "4096"
  const fallback = host ? `http://${host}:${port}` : "http://localhost:4096"
  const serverUrl = httpUrl(env.VITE_MONGOLGPT_SERVER_URL) ?? httpUrl(fallback)
  return {
    mode: local(serverUrl) ? "local-bridge" : "hosted",
    serverUrl,
  }
}
