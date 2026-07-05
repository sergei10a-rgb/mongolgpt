import { createMongolGPTClient } from "@mongolgpt/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ServerRequestInit = RequestInit & {
  directory?: string
  experimental_workspaceID?: string
}

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "mongolgpt"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "mongolgpt",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createMongolGPTClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createMongolGPTClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createServerRequest(input: { server: ServerConnection.HttpBase; fetch?: FetchLike }) {
  const auth = input.server.password
    ? `Basic ${authTokenFromCredentials({ username: input.server.username, password: input.server.password })}`
    : undefined
  const fetcher = input.fetch ?? fetch
  const base = input.server.url.endsWith("/") ? input.server.url : `${input.server.url}/`

  return (path: string, init: ServerRequestInit = {}) => {
    const { directory, experimental_workspaceID, headers: rawHeaders, ...rest } = init
    const headers = new Headers(rawHeaders)

    if (auth && !headers.has("authorization")) headers.set("authorization", auth)
    if (directory && !headers.has("x-mongolgpt-directory")) {
      headers.set("x-mongolgpt-directory", encodeURIComponent(directory))
    }
    if (experimental_workspaceID && !headers.has("x-mongolgpt-workspace")) {
      headers.set("x-mongolgpt-workspace", experimental_workspaceID)
    }

    const url = new URL(path.replace(/^\/+/, ""), base)
    return fetcher(new Request(url, { ...rest, headers }))
  }
}
