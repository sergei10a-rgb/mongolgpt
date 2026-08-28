import type { DownloadPlatform } from "./types"

const assetNames: Record<DownloadPlatform, string> = {
  "darwin-aarch64-dmg": "mongolgpt-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "mongolgpt-desktop-mac-x64.dmg",
  "windows-x64-nsis": "mongolgpt-desktop-win-x64.exe",
  "linux-x64-deb": "mongolgpt-desktop-linux-x64.deb",
  "linux-x64-rpm": "mongolgpt-desktop-linux-x64.rpm",
  "linux-x64-appimage": "mongolgpt-desktop-linux-x64.AppImage",
}

export const downloadNames: Partial<Record<DownloadPlatform, string>> = {
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

export function isDownloadPlatform(platform: string): platform is DownloadPlatform {
  return (
    platform === "darwin-aarch64-dmg" ||
    platform === "darwin-x64-dmg" ||
    platform === "windows-x64-nsis" ||
    platform === "linux-x64-deb" ||
    platform === "linux-x64-appimage" ||
    platform === "linux-x64-rpm"
  )
}
