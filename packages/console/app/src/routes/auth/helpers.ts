export function safeAuthContinue(value: string | null) {
  if (!value) return ""
  if (!value.startsWith("/") || value.startsWith("//")) return ""

  try {
    const url = new URL(value, "https://auth.invalid")
    if (url.origin !== "https://auth.invalid") return ""
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return ""
  }
}

export function authCallbackTarget(url: URL) {
  const pathname =
    url.pathname === "/auth/callback" ? "/auth" : url.pathname.replace("/auth/callback", "") || "/auth"
  const search = new URLSearchParams(url.search)
  for (const name of ["code", "state", "error", "error_description", "error_uri"]) search.delete(name)
  const target = `${pathname}${search.size ? `?${search}` : ""}`
  return safeAuthContinue(target) || "/auth"
}

export function configuredAppUrl(value: string | undefined) {
  const raw = value?.trim()
  if (!raw) return undefined

  try {
    const url = new URL(raw)
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined
    if (url.username || url.password) return undefined
    url.hash = ""
    return url
  } catch {
    return undefined
  }
}
