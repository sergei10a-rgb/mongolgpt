import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "../../..")
const file = (path: string) => readFileSync(resolve(root, path))
const text = (path: string) => file(path).toString("utf8")

const browserRoots = [
  "packages/ui/src/assets/favicon",
  "packages/app/public",
  "packages/web/public",
  "packages/console/app/public",
  "packages/enterprise/public",
]
const browserAssets = [
  "favicon.svg",
  "favicon-v3.svg",
  "favicon.ico",
  "favicon-v3.ico",
  "favicon-96x96.png",
  "favicon-96x96-v3.png",
  "apple-touch-icon.png",
  "apple-touch-icon-v3.png",
  "web-app-manifest-192x192.png",
  "web-app-manifest-512x512.png",
]

describe("MongolGPT brand asset contract", () => {
  test("uses one geometric M mark across user-visible SVG sources", () => {
    const sources = [
      "packages/identity/mark.svg",
      "packages/identity/mark-light.svg",
      "packages/identity/wordmark-dark.svg",
      "packages/identity/wordmark-light.svg",
      "packages/identity/social-share.svg",
      "packages/ui/src/components/logo.tsx",
      "packages/core/src/oauth/page.ts",
      "packages/web/src/components/icons/custom.tsx",
      "packages/web/src/assets/logo-dark.svg",
      "packages/web/src/assets/logo-light.svg",
      "packages/stats/app/src/asset/logo-ornate-dark.svg",
      "packages/stats/app/src/asset/logo-ornate-light.svg",
      "packages/console/app/src/asset/logo.svg",
      "packages/console/app/src/asset/lander/brand-assets-dark.svg",
      "packages/console/app/src/asset/lander/brand-assets-light.svg",
    ].map(text)

    for (const source of sources) {
      expect(source).not.toContain("M178 168L294 256L178 344")
      expect(source).not.toContain("M16.8 15.4L27.2 24L16.8 32.6")
      expect(source).not.toContain("M8.4 7.9L13.8 12L8.4 16.1")
      expect(source).not.toContain('stroke="#26E6F2"')
      expect(source).not.toContain('fill="#37F28B"')
    }

    expect(sources.some((source) => source.includes("M148 350V162L256 264L364 162V350"))).toBeTrue()
    expect(sources.some((source) => source.includes("M6.8 16.8V7.2L12 12.2L17.2 7.2V16.8"))).toBeTrue()
  })

  test("keeps every browser and PWA copy byte-identical to the UI source", () => {
    for (const asset of browserAssets) {
      const expected = file(`packages/ui/src/assets/favicon/${asset}`)
      for (const directory of browserRoots.slice(1)) {
        expect(file(`${directory}/${asset}`).equals(expected)).toBeTrue()
      }
    }

    for (const directory of browserRoots) {
      const png = file(`${directory}/apple-touch-icon-v3.png`)
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    }
  })

  test("keeps Desktop channels on the canonical source without stale ICNS files", () => {
    const mark = file("packages/identity/mark.svg")
    const ico = file("packages/desktop/icons/prod/icon.ico")
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(6)

    for (const channel of ["dev", "beta", "prod"]) {
      const directory = `packages/desktop/icons/${channel}`
      expect(file(`${directory}/icon.svg`).equals(mark)).toBeTrue()
      expect(file(`${directory}/icon.ico`).equals(ico)).toBeTrue()
      expect(file(`${directory}/icon.png`).equals(file("packages/desktop/icons/prod/icon.png"))).toBeTrue()
      expect(existsSync(resolve(root, directory, "icon.icns"))).toBeFalse()
    }

    expect(text("packages/desktop/electron-builder.config.ts")).toContain("icon: `resources/icons/icon.svg`")
  })

  test("ships deterministic social and downloadable brand bundles", () => {
    const social = file("packages/ui/src/assets/images/social-share.png")
    for (const target of [
      "packages/app/public/social-share.png",
      "packages/web/public/social-share.png",
      "packages/console/app/public/social-share.png",
      "packages/enterprise/public/social-share.png",
    ]) {
      expect(file(target).equals(social)).toBeTrue()
    }

    const archive = file("packages/console/app/public/mongolgpt-brand-assets.zip")
    expect(archive.subarray(0, 4).toString("hex")).toBe("504b0304")
    expect(file("packages/console/app/src/asset/brand/mongolgpt-brand-assets.zip").equals(archive)).toBeTrue()
  })

  test("exposes idempotent brand generation commands", () => {
    const packageJson = JSON.parse(text("package.json")) as { scripts: Record<string, string> }
    expect(packageJson.scripts["brand:generate"]).toBe("bun script/generate-brand-assets.ts")
    expect(packageJson.scripts["brand:check"]).toBe("bun script/generate-brand-assets.ts --check")
    expect(text("script/generate-brand-assets.ts")).toContain("Brand asset parity: OK")
  })
})
