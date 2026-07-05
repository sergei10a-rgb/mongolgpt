import type { APIEvent } from "@solidjs/start"
import type { DownloadPlatform } from "../types"

const prodAssetNames: Partial<Record<DownloadPlatform, string>> = {
  "windows-x64-nsis": "mongolgpt-desktop-win-x64.exe",
}

const betaAssetNames: Partial<Record<DownloadPlatform, string>> = {
  "windows-x64-nsis": "mongolgpt-desktop-win-x64.exe",
}

// Doing this on the server lets us preserve the original name for platforms we don't care to rename for
const downloadNames: Partial<Record<DownloadPlatform, string>> = {
  "windows-x64-nsis": "MongolGPT Desktop Installer.exe",
}

export async function GET({ params: { platform, channel } }: APIEvent) {
  if (!isDownloadPlatform(platform)) return new Response(null, { status: 404 })
  const assetName = channel === "stable" ? prodAssetNames[platform] : betaAssetNames[platform]
  if (!assetName) return new Response(null, { status: 404 })

  const resp = await fetch(`https://github.com/sergei10a-rgb/mongolgpt/releases/latest/download/${assetName}`)

  const downloadName = downloadNames[platform]

  const headers = new Headers(resp.headers)
  if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`)

  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
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
