import type { APIEvent } from "@solidjs/start"
import { downloadAssetUrl, downloadNames, isDownloadPlatform } from "../assets"

type DownloadEvent = Pick<APIEvent, "params" | "request">

export async function GET({ params: { platform, channel }, request }: DownloadEvent) {
  const assetUrl = downloadAssetUrl(channel, platform)
  if (!assetUrl) return new Response(null, { status: 404 })
  const probe = new URL(request.url).searchParams.get("availability") === "1"
  if (request.method === "HEAD" || probe) return availability(assetUrl, platform, request.method !== "HEAD")
  return Response.redirect(assetUrl, 302)
}

async function availability(assetUrl: string, platform: string, includeBody: boolean) {
  const response = await fetch(assetUrl, {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": "mongolgpt-download-check" },
    signal: AbortSignal.timeout(4_000),
  }).catch(() => undefined)
  const available = response?.ok === true
  const headers = new Headers({
    "cache-control": available ? "public, max-age=300" : "public, max-age=60",
    "x-mongolgpt-download-available": available ? "1" : "0",
  })
  if (available && isDownloadPlatform(platform)) {
    const downloadName = downloadNames[platform]
    if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`)
  }
  if (!includeBody) return new Response(null, { status: 200, headers })
  headers.set("content-type", "application/json; charset=utf-8")
  return new Response(JSON.stringify({ available }), { status: 200, headers })
}
