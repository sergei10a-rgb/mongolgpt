import { productServiceUrls } from "@mongolgpt/core/product"

export const normalizeServerUrl = (input: string): string => {
  const url = new URL(input)
  url.search = ""
  url.hash = ""

  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname.length === 0 || accountUiPaths.has(pathname)) return url.origin
  return `${url.origin}${pathname}`
}

export const defaultConsoleUrl = process.env.MONGOLGPT_CONSOLE_URL?.trim() || productServiceUrls.console
export const defaultAuthUrl = process.env.MONGOLGPT_AUTH_URL?.trim() || productServiceUrls.auth

const accountUiPaths = new Set(["/auth", "/console", "/go", "/workspace", "/zen"])

export const resolveAuthServerUrl = (input: string): string => {
  const override = process.env.MONGOLGPT_AUTH_URL
  if (override) return normalizeServerUrl(override)

  const url = new URL(input)
  url.search = ""
  url.hash = ""

  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname.startsWith("/auth")) return pathname.length === 0 ? url.origin : `${url.origin}${pathname}`
  if (url.hostname.startsWith("auth.")) return pathname.length === 0 ? url.origin : `${url.origin}${pathname}`

  if (normalizeServerUrl(input) === normalizeServerUrl(defaultConsoleUrl)) return defaultAuthUrl

  return normalizeServerUrl(input)
}
