import type { APIEvent } from "@solidjs/start/server"
import { Resource } from "@mongolgpt/console-resource"
import { verifyCliToken } from "~/lib/cli-auth"
import { z } from "zod"

const TokenRequest = z.object({
  grant_type: z.string().optional(),
  refresh_token: z.string().optional(),
})

export async function POST(event: APIEvent) {
  const body = TokenRequest.safeParse(await event.request.json().catch(() => undefined))
  if (!body.success) return oauthError("invalid_request", "JSON request body шаардлагатай", 400)

  if (body.data.grant_type !== "refresh_token") {
    return oauthError(
      "unsupported_grant_type",
      "MongolGPT CLI эхний нэвтрэлтэд browser OAuth ашигладаг. Энэ endpoint зөвхөн хадгалсан token шинэчилнэ.",
      400,
    )
  }

  if (!body.data.refresh_token) return oauthError("invalid_request", "refresh_token алга", 400)

  const response = await fetch(`${Resource.AUTH_API_URL.value}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: body.data.refresh_token,
    }).toString(),
  })

  const text = await response.text()
  if (response.ok) {
    const payload = parseTokenResponse(text)
    if (!payload?.access_token || !(await verifyCliToken(payload.access_token))) {
      return oauthError(
        "invalid_grant",
        "Нэвтрэх эрх хүчингүй болсон. MongolGPT-д browser OAuth-оор дахин нэвтэрнэ үү.",
        400,
      )
    }
  }
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  })
}

function parseTokenResponse(value: string): { access_token: string } | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== "object" || parsed === null || !("access_token" in parsed)) return undefined
    if (typeof parsed.access_token !== "string") return undefined
    return { access_token: parsed.access_token }
  } catch {
    return undefined
  }
}

function oauthError(error: string, error_description: string, status: number) {
  return Response.json({ error, error_description }, { status, headers: { "Cache-Control": "no-store" } })
}
