export const hostedPreviewOrigin = "https://preview.dev.mgpt.mn"
export const hostedPreviewOwnerEmail = "sergei10a@gmail.com"

const hostedPreviewAppUrl = "https://app.dev.mgpt.mn"
const hostedPreviewRuntimeUrl = "https://runtime.dev.mgpt.mn"
const hostedPreviewConsoleUrl = "https://dev.mgpt.mn"

export type HostedPreviewConfigInput = {
  enabled: boolean
  hostedAppUrl: string | undefined
  hostedRuntimeUrl: string | undefined
  hostedConsoleUrl: string | undefined
}

export function hostedPreviewConfig(input: HostedPreviewConfigInput) {
  if (
    !input.enabled ||
    input.hostedAppUrl !== hostedPreviewAppUrl ||
    input.hostedRuntimeUrl !== hostedPreviewRuntimeUrl ||
    input.hostedConsoleUrl !== hostedPreviewConsoleUrl
  ) {
    return undefined
  }
  return { origin: hostedPreviewOrigin, ownerEmail: hostedPreviewOwnerEmail }
}

export function hostedPreviewRuntimeAudience(
  input: HostedPreviewConfigInput & { requestOrigin: string | null; accountEmail: string },
):
  | { matched: false }
  | { matched: true; status: "disabled" | "forbidden" }
  | { matched: true; status: "allowed"; audience: string } {
  if (input.requestOrigin !== hostedPreviewOrigin) return { matched: false }

  const config = hostedPreviewConfig(input)
  if (!config) return { matched: true, status: "disabled" }
  if (input.accountEmail !== config.ownerEmail) return { matched: true, status: "forbidden" }
  return { matched: true, status: "allowed", audience: config.origin }
}

export function hostedPreviewReturn(accountEmail: string | undefined) {
  const headers = { "Cache-Control": "no-store" }
  if (!accountEmail)
    return new Response(null, {
      status: 302,
      headers: { ...headers, Location: "https://dev.mgpt.mn/auth/authorize?continue=/auth/preview" },
    })
  if (accountEmail !== hostedPreviewOwnerEmail)
    return Response.json({ error: "preview_forbidden" }, { status: 403, headers })
  return new Response(null, { status: 302, headers: { ...headers, Location: hostedPreviewOrigin + "/" } })
}
