import { createRemoteJWKSet, jwtVerify } from "jose"
import type { JWTVerifyGetKey } from "jose"
import { isStaticAppBackendPath } from "../../../../app/src/utils/static-app-router"

const origin = "https://preview.dev.mgpt.mn"
const team = "https://raspy-frog-02f6.cloudflareaccess.com"
const owner = "sergei10a@gmail.com"
const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", team))

interface Service {
  fetch(request: Request): Promise<Response>
}

export interface PreviewEnvironment {
  STAGE: string
  ACCESS_AUDIENCE: string
  ACCESS_TEAM_DOMAIN: string
  ASSETS: Service
  CANDIDATE: Service
}

export async function previewRequest(request: Request, env: PreviewEnvironment, resolver: JWTVerifyGetKey = keys) {
  const url = new URL(request.url)
  if (env.STAGE !== "dev" || env.ACCESS_TEAM_DOMAIN !== team || !/^[a-f0-9]{64}$/.test(env.ACCESS_AUDIENCE)) {
    return denied(503)
  }
  if (url.origin !== origin || url.username || url.password) return denied(403)
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion")
  if (!assertion || assertion.length > 16_384) return denied(403)
  try {
    const { payload } = await jwtVerify(assertion, resolver, {
      issuer: team,
      audience: env.ACCESS_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "email"],
      clockTolerance: 5,
    })
    if (
      payload.email !== owner ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 255 ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.iat > Date.now() / 1000 + 5 ||
      payload.exp <= payload.iat
    )
      return denied(403)
  } catch {
    return denied(403)
  }

  if (!isStaticAppBackendPath(url.pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") return denied(405)
    return env.ASSETS.fetch(request)
  }
  if (url.pathname.startsWith("/auth") && url.pathname !== "/auth/session") return denied(404)
  const requestOrigin = request.headers.get("Origin")
  const sameOriginRead =
    !requestOrigin &&
    (request.method === "GET" || request.method === "HEAD") &&
    request.headers.get("Sec-Fetch-Site") === "same-origin"
  if (requestOrigin !== origin && !sameOriginRead) return denied(403)

  // Forward only the native client's protocol, never Access credentials or caller-supplied gateway identity.
  const headers = new Headers({ Origin: "https://app.dev.mgpt.mn" })
  for (const name of [
    "Accept",
    "Content-Type",
    "Authorization",
    "Upgrade",
    "Sec-WebSocket-Protocol",
    "x-mongolgpt-directory",
    "x-mongolgpt-runtime-read-retry",
  ]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const cookies = request.headers
    .get("Cookie")
    ?.split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("__Host-mongolgpt-runtime="))
  if (cookies?.length) headers.set("Cookie", cookies.join("; "))
  const upstream = await env.CANDIDATE.fetch(
    new Request(request.url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
      // Node's Request implementation requires duplex for streaming request bodies.
      ...(request.body ? { duplex: "half" as const } : {}),
    }),
  )
  if (upstream.status === 101) return upstream
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.set("Cache-Control", "no-store")
  responseHeaders.set("Access-Control-Allow-Origin", origin)
  responseHeaders.set("X-Content-Type-Options", "nosniff")
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

function denied(status: number) {
  return Response.json(
    { error: "preview_access_denied" },
    {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    },
  )
}

export default { fetch: (request: Request, env: PreviewEnvironment) => previewRequest(request, env) }
