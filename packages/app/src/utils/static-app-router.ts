export const staticAppBackendPrefixes = [
  "agent",
  "api",
  "auth",
  "command",
  "compat",
  "config",
  "doc",
  "event",
  "experimental",
  "file",
  "find",
  "formatter",
  "global",
  "instance",
  "log",
  "lsp",
  "mcp",
  "model",
  "path",
  "permission",
  "project",
  "provider",
  "pty",
  "question",
  "session",
  "skill",
  "sync",
  "tui",
  "v1",
  "vcs",
  "workspace",
] as const

const backendPrefixes = new Set<string>(staticAppBackendPrefixes)

const criticalBackendPaths = [
  "/api/health",
  "/global/health",
  "/v1/account/overview",
  "/auth/runtime-token",
  "/auth/session",
  "/session",
  "/provider",
  "/project",
] as const

export const staticAppBackendBoundaryPaths = [
  ...criticalBackendPaths,
  ...staticAppBackendPrefixes.map((prefix) => `/${prefix}/__mongolgpt_static_boundary_probe__`),
] as const

export interface StaticAssetsBinding {
  fetch(request: Request): Promise<Response>
}

export function isStaticAppBackendPath(pathname: string) {
  const prefix = pathname.split("/", 3)[1]?.toLowerCase()
  return Boolean(prefix && backendPrefixes.has(prefix))
}

export async function routeStaticAppRequest(request: Request, assets: StaticAssetsBinding) {
  if (!isStaticAppBackendPath(new URL(request.url).pathname)) return assets.fetch(request)

  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  })
  const body =
    request.method === "HEAD"
      ? null
      : JSON.stringify({
          code: "STATIC_APP_API_ROUTE",
          message: "MongolGPT веб аппын хаяг дээр API ажиллахгүй. Тохируулсан backend хаягийг ашиглана уу.",
        })
  return new Response(body, { status: 404, headers })
}
