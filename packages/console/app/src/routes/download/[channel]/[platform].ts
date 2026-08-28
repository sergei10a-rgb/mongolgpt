import type { APIEvent } from "@solidjs/start"
import { downloadAssetUrl, downloadNames, isDownloadPlatform } from "../assets"

type DownloadEvent = Pick<APIEvent, "params" | "request">

export async function GET({ params: { platform, channel }, request }: DownloadEvent) {
  const assetUrl = downloadAssetUrl(channel, platform)
  if (!assetUrl) return new Response(null, { status: 404 })
  if (request.method === "HEAD") return availability(assetUrl, platform)
  return Response.redirect(assetUrl, 302)
}

async function availability(assetUrl: string, platform: string) {
  const response = await fetch(assetUrl, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "mongolgpt-download-check" },
  }).catch(() => undefined)
  const available = response && response.status >= 200 && response.status < 400
  const headers = new Headers({
    "cache-control": available ? "public, max-age=300" : "public, max-age=60",
  })
  if (available && isDownloadPlatform(platform)) {
    const downloadName = downloadNames[platform]
    if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`)
  }
  return new Response(null, { status: available ? 204 : 404, headers })
}
