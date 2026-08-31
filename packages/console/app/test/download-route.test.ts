import { afterEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { downloadAssetUrl } from "../src/routes/download/assets"
import { GET } from "../src/routes/download/[channel]/[platform]"

const originalFetch = globalThis.fetch

function event(channel: string, platform: string, method = "GET", query = "") {
  return { params: { channel, platform }, request: new Request(`https://mgpt.mn/download${query}`, { method }) }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("desktop download route", () => {
  test("keeps the download page hero and account setup guidance visible", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/routes/download/index.tsx"), "utf8")
    const styles = readFileSync(resolve(import.meta.dirname, "../src/routes/download/index.css"), "utf8")
    expect(source).toContain('data-component="download-hero"')
    expect(source).toContain('data-component="download-setup"')
    expect(source).toContain('href: "/support"')
    expect(styles).toContain('[data-component="download-hero"] {\n    display: grid;')
  })

  test("installs the published CLI package instead of bootstrapping the source repository", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/routes/download/index.tsx"), "utf8")
    expect(source).toContain('handleCopyClick("npm install --global mongolgpt")')
    expect(source).toContain("npm install --global <strong>mongolgpt</strong>")
    expect(source).not.toContain("git clone https://github.com/sergei10a-rgb/mongolgpt && cd mongolgpt && bun install")
  })

  test("keeps shared helpers outside the method-picked SolidStart route module", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/routes/download/[channel]/[platform].ts"), "utf8")
    expect(source).toContain('from "../assets"')
    expect(source).toContain('request.method === "HEAD"')
    expect(source).not.toContain("export async function HEAD")
  })

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

  test("redirects downloads directly to GitHub instead of proxying large installers", async () => {
    const response = await GET(event("stable", "windows-x64-nsis"))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(
      "https://github.com/sergei10a-rgb/mongolgpt/releases/latest/download/mongolgpt-desktop-win-x64.exe",
    )
  })

  test("reports availability without downloading the installer body", async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("HEAD")
      expect(init?.redirect).toBe("follow")
      expect(init?.signal).toBeDefined()
      return new Response(null, { status: 200 })
    })
    globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect })

    const response = await GET(event("stable", "linux-x64-deb", "GET", "?availability=1"))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    expect(response.headers.get("x-mongolgpt-download-available")).toBe("1")
    expect(await response.json()).toEqual({ available: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("does not report an unresolved GitHub redirect as an available artifact", async () => {
    globalThis.fetch = Object.assign(
      mock(async () => new Response(null, { status: 302 })),
      {
        preconnect: originalFetch.preconnect,
      },
    )

    const response = await GET(event("stable", "darwin-x64-dmg", "GET", "?availability=1"))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=60")
    expect(response.headers.get("x-mongolgpt-download-available")).toBe("0")
  })

  test("keeps missing or unsupported artifacts hidden", async () => {
    globalThis.fetch = Object.assign(
      mock(async () => new Response(null, { status: 404 })),
      {
        preconnect: originalFetch.preconnect,
      },
    )
    const missing = await GET(event("stable", "darwin-x64-dmg", "GET", "?availability=1"))
    expect(missing.status).toBe(200)
    expect(missing.headers.get("x-mongolgpt-download-available")).toBe("0")
    expect((await GET(event("beta", "windows-x64-nsis", "GET", "?availability=1"))).status).toBe(404)
  })
})
