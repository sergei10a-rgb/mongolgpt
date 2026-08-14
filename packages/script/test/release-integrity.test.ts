import { describe, expect, test } from "bun:test"
import {
  CLI_RELEASE_ASSETS,
  DESKTOP_RELEASE_ASSETS,
  RELEASE_CHECKSUM_ASSET,
  RELEASE_ARTIFACTS,
  createSha256Sums,
  validateReleaseChecksumContract,
} from "../src/release-integrity"

const files = RELEASE_ARTIFACTS.map((name) => ({ name, bytes: new TextEncoder().encode(name) }))

describe("release integrity contract", () => {
  test("creates stable lowercase basenames in sorted order", () => {
    const text = createSha256Sums([...files].reverse())
    const lines = text.trimEnd().split("\n")
    expect(lines.map((line) => line.slice(66))).toEqual([...RELEASE_ARTIFACTS].sort())
    expect(lines.every((line) => /^[0-9a-f]{64}  [^\\/]+$/.test(line))).toBe(true)
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
})
