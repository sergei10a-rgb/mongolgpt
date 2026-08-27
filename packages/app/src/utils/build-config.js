const channels = new Set(["dev", "beta", "prod"])

function httpUrl(input) {
  const value = input?.trim()
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MongolGPT-ийн ажиллах орчны URL нь http эсвэл https протокол ашиглах ёстой")
  }
  return url.toString().replace(/\/+$/, "")
}

function local(url) {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "")
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  )
}

function hostedWeb(env) {
  return (
    Boolean(env.VITE_MONGOLGPT_APP_URL?.trim() || env.VITE_MONGOLGPT_PUBLIC_URL?.trim()) &&
    channels.has(resolveChannel(env))
  )
}

export function resolveChannel(env = process.env) {
  const raw = env.MONGOLGPT_CHANNEL ?? env.VITE_MONGOLGPT_CHANNEL
  if (channels.has(raw)) return raw
  if (raw === "latest") return "prod"
  return "dev"
}

export function resolveReleaseSha(env = process.env) {
  const value = env.VITE_MONGOLGPT_RELEASE_SHA?.trim()
  if (!value) {
    if (hostedWeb(env)) {
      throw new Error("MongolGPT-ийн байршуулсан веб хувилбарт Git release SHA шаардлагатай")
    }
    return "local"
  }
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error("MongolGPT release SHA нь 40 тэмдэгт Git commit hash байна")
  }
  return value.toLowerCase()
}

export function resolveRuntimeMetadata(env = process.env) {
  const appUrl = env.VITE_MONGOLGPT_APP_URL ? httpUrl(env.VITE_MONGOLGPT_APP_URL) : undefined
  const publicUrl = env.VITE_MONGOLGPT_PUBLIC_URL ? httpUrl(env.VITE_MONGOLGPT_PUBLIC_URL) : undefined
  const host = env.VITE_MONGOLGPT_SERVER_HOST?.trim()
  const port = env.VITE_MONGOLGPT_SERVER_PORT?.trim() || "4096"
  const fallback = host ? `http://${host}:${port}` : "http://localhost:4096"
  const configured = httpUrl(env.VITE_MONGOLGPT_SERVER_URL)
  const hosted = hostedWeb(env)
  if (hosted && (!appUrl || local(appUrl) || new URL(appUrl).protocol !== "https:")) {
    throw new Error("MongolGPT-ийн байршуулсан веб хувилбарт локал бус HTTPS аппын URL шаардлагатай")
  }
  if (hosted && (!publicUrl || local(publicUrl) || new URL(publicUrl).protocol !== "https:")) {
    throw new Error("MongolGPT-ийн байршуулсан веб хувилбарт локал бус, нийтэд нээлттэй HTTPS URL шаардлагатай")
  }
  if (
    hosted &&
    (!configured ||
      local(configured) ||
      (appUrl && new URL(configured).origin === new URL(appUrl).origin) ||
      (publicUrl && new URL(configured).origin === new URL(publicUrl).origin) ||
      new URL(configured).pathname !== "/" ||
      new URL(configured).search !== "" ||
      new URL(configured).hash !== "" ||
      new URL(configured).protocol !== "https:")
  ) {
    throw new Error("MongolGPT-ийн байршуулсан веб хувилбарт локал бус HTTPS ажиллах орчны URL шаардлагатай")
  }

  const serverUrl = configured ?? httpUrl(fallback)
  return {
    mode: local(serverUrl) ? "local-bridge" : "hosted",
    serverUrl,
  }
}
