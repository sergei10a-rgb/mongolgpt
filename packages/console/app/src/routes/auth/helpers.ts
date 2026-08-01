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
  const pathname = url.pathname === "/auth/callback" ? "/auth" : url.pathname.replace("/auth/callback", "") || "/auth"
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

export function canonicalHttpsOrigin(value: string | undefined) {
  const raw = value?.trim()
  if (!raw) return undefined

  try {
    const url = new URL(raw)
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

export type AuthAccount = {
  id: string
  email: string
  authVersion?: number
}

export function currentAuthAccount(session: { data: { account?: Record<string, AuthAccount>; current?: string } }) {
  const current = session.data.current
  if (!current) return undefined
  const account = session.data.account?.[current]
  if (!account || account.id !== current) return undefined
  if (typeof account.email !== "string" || !account.email.trim() || account.email.trim() !== account.email) {
    return undefined
  }
  if (account.authVersion !== undefined && (!Number.isSafeInteger(account.authVersion) || account.authVersion < 0)) {
    return undefined
  }
  return account
}
