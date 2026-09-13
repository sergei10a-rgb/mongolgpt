import type { APIEvent } from "@solidjs/start/server"
import { getActor } from "~/context/auth"
import { hostedAppUrl, hostedConsoleUrl, hostedPreviewEnabled, hostedRuntimeUrl } from "~/lib/hosted-env"
import { hostedPreviewConfig, hostedPreviewReturn } from "~/lib/hosted-preview"

export async function GET(input: APIEvent) {
  const preview = hostedPreviewConfig({
    enabled: hostedPreviewEnabled,
    hostedAppUrl,
    hostedRuntimeUrl,
    hostedConsoleUrl,
  })
  if (!preview || new URL(input.request.url).origin !== hostedConsoleUrl) {
    return Response.json(
      { error: "preview_not_available", message: "Preview нэвтрэлт идэвхгүй байна." },
      { status: 404, headers: { "cache-control": "no-store" } },
    )
  }

  const actor = await getActor()
  return hostedPreviewReturn(actor.type === "account" ? actor.properties.email : undefined)
}
