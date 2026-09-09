import { createMongolGPTClient } from "@mongolgpt/sdk/v2/client"
import { isRuntimeReadRetryScope, runtimeReadRetryHeader } from "@mongolgpt/runtime-auth/read-retry"
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

export function isHostedServer(url: string) {
  try {
    const hostname = new URL(url).hostname
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1"
  } catch {
    return false
  }
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
    fetch: isHostedServer(server.url)
      ? Object.assign(runtimeReadRetryFetch(config.fetch ?? globalThis.fetch, server.url), {
          preconnect: config.fetch?.preconnect ?? globalThis.fetch.preconnect,
        })
      : config.fetch,
    credentials: config.credentials ?? (isHostedServer(server.url) ? "include" : undefined),
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
  const fetcher = isHostedServer(input.server.url)
    ? runtimeReadRetryFetch(input.fetch ?? fetch, input.server.url)
    : (input.fetch ?? fetch)
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
    return fetcher(
      new Request(url, {
        ...rest,
        credentials: rest.credentials ?? (isHostedServer(input.server.url) ? "include" : undefined),
        headers,
      }),
    )
  }
}

function runtimeReadRetryFetch(fetcher: FetchLike, serverUrl: string): FetchLike {
  const origin = new URL(serverUrl).origin
  return async (input, init) => {
    const request = new Request(input, init)
    const response = await fetcher(request)
    const scope = response.headers.get(runtimeReadRetryHeader)
    if (
      response.status !== 401 ||
      !isRuntimeReadRetryScope(scope) ||
      (request.method !== "GET" && request.method !== "HEAD") ||
      request.credentials !== "include" ||
      request.headers.has("authorization") ||
      request.headers.has(runtimeReadRetryHeader) ||
      request.signal.aborted ||
      new URL(request.url).origin !== origin
    )
      return response

    // The account gate refreshes cookies while admission is pending. The server
    // re-authenticates this read and rejects any account/workspace/revocation change.
    const retry = new Request(request)
    retry.headers.set(runtimeReadRetryHeader, scope)
    void response.body?.cancel().catch(() => {})
    return fetcher(retry)
  }
}
