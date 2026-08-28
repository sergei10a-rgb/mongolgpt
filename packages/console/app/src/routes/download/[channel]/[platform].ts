import type { APIEvent } from "@solidjs/start"
import type { DownloadPlatform } from "../types"

type DownloadEvent = Pick<APIEvent, "params">

const assetNames: Record<DownloadPlatform, string> = {
  "darwin-aarch64-dmg": "mongolgpt-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "mongolgpt-desktop-mac-x64.dmg",
  "windows-x64-nsis": "mongolgpt-desktop-win-x64.exe",
  "linux-x64-deb": "mongolgpt-desktop-linux-x64.deb",
  "linux-x64-rpm": "mongolgpt-desktop-linux-x64.rpm",
  "linux-x64-appimage": "mongolgpt-desktop-linux-x64.AppImage",
}

const downloadNames: Partial<Record<DownloadPlatform, string>> = {
  "darwin-aarch64-dmg": "MongolGPT Desktop Apple Silicon.dmg",
  "darwin-x64-dmg": "MongolGPT Desktop Intel.dmg",
  "windows-x64-nsis": "MongolGPT Desktop Installer.exe",
  "linux-x64-deb": "mongolgpt-desktop-linux-x64.deb",
  "linux-x64-rpm": "mongolgpt-desktop-linux-x64.rpm",
  "linux-x64-appimage": "mongolgpt-desktop-linux-x64.AppImage",
}

export function downloadAssetUrl(channel: string, platform: string): string | undefined {
  if (channel !== "stable" || !isDownloadPlatform(platform)) return undefined
  return `https://github.com/sergei10a-rgb/mongolgpt/releases/latest/download/${assetNames[platform]}`
}

export function GET({ params: { platform, channel } }: DownloadEvent) {
  const assetUrl = downloadAssetUrl(channel, platform)
  if (!assetUrl) return new Response(null, { status: 404 })
  return Response.redirect(assetUrl, 302)
}

export async function HEAD({ params: { platform, channel } }: DownloadEvent) {
  const assetUrl = downloadAssetUrl(channel, platform)
  if (!assetUrl || !isDownloadPlatform(platform)) return unavailable()

  const response = await fetch(assetUrl, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "mongolgpt-download-check" },
  }).catch(() => undefined)
  const available = response && response.status >= 200 && response.status < 400
  const headers = new Headers({
    "cache-control": available ? "public, max-age=300" : "public, max-age=60",
  })
  if (available) {
    const downloadName = downloadNames[platform]
    if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`)
  }
  return new Response(null, { status: available ? 204 : 404, headers })
}

function unavailable() {
  return new Response(null, { status: 404, headers: { "cache-control": "public, max-age=60" } })
}

function isDownloadPlatform(platform: string): platform is DownloadPlatform {
  return (
    platform === "darwin-aarch64-dmg" ||
    platform === "darwin-x64-dmg" ||
    platform === "windows-x64-nsis" ||
    platform === "linux-x64-deb" ||
    platform === "linux-x64-appimage" ||
    platform === "linux-x64-rpm"
  )
}
