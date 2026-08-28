import { afterEach, describe, expect, mock, test } from "bun:test"
import { GET, HEAD, downloadAssetUrl } from "../src/routes/download/[channel]/[platform]"

const originalFetch = globalThis.fetch

function event(channel: string, platform: string) {
  return { params: { channel, platform } }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("desktop download route", () => {
  test("maps every stable desktop platform to the release asset produced by CI", () => {
    expect(downloadAssetUrl("stable", "darwin-aarch64-dmg")).toEndWith("mongolgpt-desktop-mac-arm64.dmg")
    expect(downloadAssetUrl("stable", "darwin-x64-dmg")).toEndWith("mongolgpt-desktop-mac-x64.dmg")
    expect(downloadAssetUrl("stable", "windows-x64-nsis")).toEndWith("mongolgpt-desktop-win-x64.exe")
    expect(downloadAssetUrl("stable", "linux-x64-deb")).toEndWith("mongolgpt-desktop-linux-x64.deb")
    expect(downloadAssetUrl("stable", "linux-x64-rpm")).toEndWith("mongolgpt-desktop-linux-x64.rpm")
    expect(downloadAssetUrl("stable", "linux-x64-appimage")).toEndWith("mongolgpt-desktop-linux-x64.AppImage")
    expect(downloadAssetUrl("beta", "windows-x64-nsis")).toBeUndefined()
    expect(downloadAssetUrl("stable", "unknown")).toBeUndefined()
  })

  test("redirects downloads directly to GitHub instead of proxying large installers", () => {
    const response = GET(event("stable", "windows-x64-nsis"))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(
      "https://github.com/sergei10a-rgb/mongolgpt/releases/latest/download/mongolgpt-desktop-win-x64.exe",
    )
  })

  test("reports availability without downloading the installer body", async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("HEAD")
      expect(init?.redirect).toBe("manual")
      return new Response(null, { status: 302 })
    })
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })

    const response = await HEAD(event("stable", "linux-x64-deb"))
    expect(response.status).toBe(204)
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("keeps missing or unsupported artifacts hidden", async () => {
    globalThis.fetch = Object.assign(mock(async () => new Response(null, { status: 404 })), {
      preconnect: originalFetch.preconnect,
    })
    expect((await HEAD(event("stable", "darwin-x64-dmg"))).status).toBe(404)
    expect((await HEAD(event("beta", "windows-x64-nsis"))).status).toBe(404)
  })
})
