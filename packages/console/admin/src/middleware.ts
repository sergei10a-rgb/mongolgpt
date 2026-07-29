import { createMiddleware } from "@solidjs/start/middleware"
import {
  AdminAccessConfigurationError,
  AdminAccessVerificationError,
  loadAdminAccessConfig,
  verifyCloudflareAccessAssertion,
} from "~/lib/access"
import {
  AdminAuthorizationError,
  authorizePlatformAdmin,
  requestTarget,
  writeAdminAudit,
} from "~/lib/admin-auth"
import { setPlatformAdminContext } from "~/lib/admin-context"

export default createMiddleware({
  async onRequest(event) {
    applySecurityHeaders(event.response.headers)

    try {
      const config = loadAdminAccessConfig()
      const assertion = event.request.headers.get("cf-access-jwt-assertion")
      if (!assertion) {
        throw new AdminAccessVerificationError("Cloudflare Access баталгаажуулалт олдсонгүй.")
      }
      const identity = await verifyCloudflareAccessAssertion(assertion, config)
      const context = await authorizePlatformAdmin(identity, config, event.request)
      setPlatformAdminContext(event.locals, context)

      if (shouldAuditRequest(event.request)) {
        await writeAdminAudit({
          adminID: context.id,
          actorEmail: context.email,
          action: "admin.request",
          outcome: "success",
          request: event.request,
          targetType: "route",
          targetID: requestTarget(event.request),
        })
      }
    } catch (error) {
      if (error instanceof AdminAccessConfigurationError) {
        return protectedResponse(event.request, 503, "Админ үйлчилгээний хамгаалалтын тохиргоо бэлэн биш байна.")
      }
      if (error instanceof AdminAccessVerificationError) {
        return protectedResponse(event.request, 403, "Cloudflare Access баталгаажуулалт шаардлагатай.")
      }
      if (error instanceof AdminAuthorizationError) {
        return protectedResponse(event.request, 403, error.message)
      }
      console.error("MongolGPT admin request failed safely", {
        name: error instanceof Error ? error.name : "UnknownError",
      })
      return protectedResponse(event.request, 503, "Админ үйлчилгээ түр боломжгүй байна.")
    }
    return undefined
  },
})

function protectedResponse(request: Request, status: 403 | 503, message: string) {
  const headers = new Headers()
  applySecurityHeaders(headers)
  if (new URL(request.url).pathname.startsWith("/api/")) {
    headers.set("Content-Type", "application/json; charset=utf-8")
    return Response.json(
      {
        error: status === 403 ? "admin_access_denied" : "admin_unavailable",
        message,
      },
      { status, headers },
    )
  }
  headers.set("Content-Type", "text/plain; charset=utf-8")
  return new Response(message, { status, headers })
}

function applySecurityHeaders(headers: Headers) {
  headers.set("Cache-Control", "no-store, max-age=0")
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  )
  headers.set("Cross-Origin-Opener-Policy", "same-origin")
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
  headers.set("Referrer-Policy", "no-referrer")
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("X-Frame-Options", "DENY")
}

function shouldAuditRequest(request: Request) {
  const url = new URL(request.url)
  if (url.pathname.startsWith("/api/")) return true
  if (request.method !== "GET") return true
  return request.headers.get("accept")?.includes("text/html") ?? false
}
