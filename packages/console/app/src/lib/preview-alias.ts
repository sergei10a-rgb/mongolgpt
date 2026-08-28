export function previewAuthRedirect(requestUrl: string, publicUrl: string | undefined, rootUrl: string | undefined) {
  const request = parseUrl(requestUrl)
  const canonical = parseOrigin(publicUrl)
  const root = parseOrigin(rootUrl)
  if (!request || !canonical || !root || canonical.origin === root.origin) return undefined
  if (request.origin !== root.origin || !authPath(request.pathname)) return undefined

  return new URL(`${request.pathname}${request.search}`, canonical).toString()
}

export function previewWwwRedirect(requestUrl: string, rootUrl: string | undefined) {
  const request = parseUrl(requestUrl)
  const root = parseOrigin(rootUrl)
  if (!request || !root || request.hostname !== `www.${root.hostname}` || request.port !== root.port) return undefined

  return new URL(`${request.pathname}${request.search}`, root).toString()
}

function parseUrl(value: string | undefined) {
  try {
    const url = new URL(value ?? "")
    if (url.protocol !== "https:" || url.username || url.password) return undefined
    return url
  } catch {
    return undefined
  }
}

function parseOrigin(value: string | undefined) {
  const url = parseUrl(value)
  if (!url || url.pathname !== "/" || url.search || url.hash) return undefined
  return url
}

function authPath(pathname: string) {
  return pathname === "/auth" || pathname.startsWith("/auth/")
}
