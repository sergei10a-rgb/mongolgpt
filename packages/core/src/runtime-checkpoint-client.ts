export * as RuntimeCheckpointClient from "./runtime-checkpoint-client"

import { checkpointControlHeader, validControlToken } from "@mongolgpt/runtime-auth/control"

export { checkpointControlEnv, checkpointControlHeader, validControlToken } from "@mongolgpt/runtime-auth/control"

const origin = "http://checkpoint.mongolgpt.internal"
const paths = new Set(["/v1/bootstrap", "/v1/begin", "/v1/archive", "/v1/publish", "/v1/publish-files", "/v1/upload"])

export class RuntimeCheckpointClientError extends Error {
  constructor(message = "Runtime checkpoint request failed.") {
    super(message)
    this.name = "RuntimeCheckpointClientError"
  }
}

export function create(token: string, request: (request: Request) => Promise<Response> = fetch) {
  if (!validControlToken(token)) throw new RuntimeCheckpointClientError("Invalid runtime checkpoint control token.")

  return async (input: Request): Promise<Response> => {
    if (!allowed(input)) throw new RuntimeCheckpointClientError("Invalid runtime checkpoint request.")
    const headers = new Headers(input.headers)
    headers.set(checkpointControlHeader, token)
    try {
      const response = await request(cloneRequest(input, headers))
      if (response.redirected) {
        void response.body?.cancel().catch(() => {})
        throw new RuntimeCheckpointClientError()
      }
      return response
    } catch {
      throw new RuntimeCheckpointClientError()
    }
  }
}

function cloneRequest(request: Request, headers: Headers) {
  const init = {
    method: request.method,
    headers,
    body: request.body,
    cache: request.cache,
    credentials: request.credentials,
    duplex: "half",
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: "error",
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  } satisfies RequestInit & { duplex: "half" }
  return new Request(request.url, init)
}

function allowed(request: Request) {
  if (request.method !== "POST") return false
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return false
  }
  return (
    url.origin === origin &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.href === `${origin}${url.pathname}` &&
    paths.has(url.pathname)
  )
}
