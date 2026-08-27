const backendPrefixes = new Set([
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
])

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
