import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  CLI_RELEASE_ASSETS,
  DESKTOP_RELEASE_ASSETS,
  RELEASE_CHECKSUM_ASSET,
  RELEASE_ARTIFACTS,
  createSha256Sums,
  releaseTag,
  validateReleaseChecksumContract,
} from "../src/release-integrity"

const files = RELEASE_ARTIFACTS.map((name) => ({ name, bytes: new TextEncoder().encode(name) }))
const root = resolve(import.meta.dirname, "../../..")

describe("release integrity contract", () => {
  test("uses one validated MongolGPT release tag namespace", () => {
    expect(releaseTag("0.1.2")).toBe("mongolgpt-v0.1.2")
    expect(releaseTag("0.1.2-beta.1")).toBe("mongolgpt-v0.1.2-beta.1")
    expect(() => releaseTag("v0.1.2")).toThrow("invalid MongolGPT release version")
    expect(() => releaseTag(" 0.1.2")).toThrow("invalid MongolGPT release version")

    for (const file of [
      "script/version.ts",
      "script/publish.ts",
      "packages/desktop/scripts/finalize-latest-yml.ts",
      "packages/desktop/scripts/finalize-latest-json.ts",
    ]) {
      expect(readFileSync(resolve(root, file), "utf8")).toContain("releaseTag(")
    }
  })

  test("creates stable lowercase basenames in sorted order", () => {
    const text = createSha256Sums([...files].reverse())
    const lines = text.trimEnd().split("\n")
    expect(lines.map((line) => line.slice(66))).toEqual([...RELEASE_ARTIFACTS].sort())
    expect(lines.every((line) => /^[0-9a-f]{64}  [^\\/]+$/.test(line))).toBe(true)
  })

  test("includes the Windows ARM64 CLI archive in the public release contract", () => {
    expect(CLI_RELEASE_ASSETS).toContain("mongolgpt-windows-arm64.zip")
    expect(RELEASE_ARTIFACTS).toContain("mongolgpt-windows-arm64.zip")
  })

  test("fails closed when a CLI or Desktop artifact is absent", () => {
    expect(() => createSha256Sums(files.filter((file) => file.name !== CLI_RELEASE_ASSETS[0]))).toThrow(
      CLI_RELEASE_ASSETS[0],
    )
    expect(() => createSha256Sums(files.filter((file) => file.name !== DESKTOP_RELEASE_ASSETS[0]))).toThrow(
      DESKTOP_RELEASE_ASSETS[0],
    )
  })

  test("validates the checksum asset and exact artifact coverage", () => {
    const text = createSha256Sums(files)
    expect(validateReleaseChecksumContract([...RELEASE_ARTIFACTS, RELEASE_CHECKSUM_ASSET], text)).toEqual([])
    expect(validateReleaseChecksumContract(RELEASE_ARTIFACTS, text)).toEqual([`missing ${RELEASE_CHECKSUM_ASSET}`])
    expect(
      validateReleaseChecksumContract(
        [...RELEASE_ARTIFACTS, RELEASE_CHECKSUM_ASSET],
        text.replace(RELEASE_ARTIFACTS[0], "0".repeat(64)),
      ),
    ).toContain(`checksum missing artifacts: ${RELEASE_ARTIFACTS[0]}`)
  })

  test("excludes source maps and other non-user release files", () => {
    const text = createSha256Sums([...files, { name: "mongolgpt-desktop-win-x64.exe.map", bytes: new Uint8Array() }])
    expect(text).not.toContain(".map")
    expect(validateReleaseChecksumContract([...RELEASE_ARTIFACTS, RELEASE_CHECKSUM_ASSET], text)).toEqual([])
  })

  test("authenticates npm publish and verifies every public package", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")
    const publish = readFileSync(resolve(root, "script/publish.ts"), "utf8")
    const preflight = readFileSync(resolve(root, "packages/mongolgpt/script/release-preflight.ts"), "utf8")

    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}")
    expect(publish.indexOf("packages/ui/script/publish.ts")).toBeLessThan(publish.indexOf("release-preflight.ts --npm"))
    for (const name of ["@mongolgpt/sdk", "@mongolgpt/plugin", "@mongolgpt/ui"]) {
      expect(preflight).toContain(`"${name}"`)
    }
  })

  test("uploads Windows and Desktop assets to the release tag created by the version job", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")
    const canonicalUpload = 'gh release upload "${{ needs.version.outputs.tag }}"'

    expect(workflow.split(canonicalUpload).length - 1).toBe(2)
    expect(workflow).not.toContain('gh release upload "v${{ needs.version.outputs.version }}"')
  })
})
