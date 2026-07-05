import type { APIEvent } from "@solidjs/start/server"
import { Resource } from "@mongolgpt/console-resource"

type TokenRequest = {
  grant_type?: string
  refresh_token?: string
}

export async function POST(event: APIEvent) {
  const body = (await event.request.json().catch(() => undefined)) as TokenRequest | undefined
  if (!body) return oauthError("invalid_request", "JSON request body шаардлагатай", 400)

  if (body.grant_type !== "refresh_token") {
    return oauthError(
      "unsupported_grant_type",
      "MongolGPT CLI эхний нэвтрэлтэд browser OAuth ашигладаг. Энэ endpoint зөвхөн хадгалсан token шинэчилнэ.",
      400,
    )
  }

  if (!body.refresh_token) return oauthError("invalid_request", "refresh_token алга", 400)

  const response = await fetch(`${Resource.AUTH_API_URL.value}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: body.refresh_token,
    }).toString(),
  })

  const text = await response.text()
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  })
}

function oauthError(error: string, error_description: string, status: number) {
  return Response.json({ error, error_description }, { status, headers: { "Cache-Control": "no-store" } })
}
