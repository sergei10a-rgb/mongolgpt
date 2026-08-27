import { createHash } from "node:crypto"

export const RELEASE_CHECKSUM_ASSET = "SHA256SUMS"
const releaseVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function releaseTag(version: string) {
  if (version !== version.trim() || !releaseVersionPattern.test(version)) {
    throw new Error(`invalid MongolGPT release version: ${version}`)
  }
  return `mongolgpt-v${version}`
}

export const CLI_RELEASE_ASSETS = [
  "mongolgpt-linux-arm64.tar.gz",
  "mongolgpt-linux-x64.tar.gz",
  "mongolgpt-linux-x64-baseline.tar.gz",
  "mongolgpt-linux-arm64-musl.tar.gz",
  "mongolgpt-linux-x64-musl.tar.gz",
  "mongolgpt-linux-x64-baseline-musl.tar.gz",
  "mongolgpt-darwin-arm64.zip",
  "mongolgpt-darwin-x64.zip",
  "mongolgpt-darwin-x64-baseline.zip",
  "mongolgpt-windows-arm64.zip",
  "mongolgpt-windows-x64.zip",
  "mongolgpt-windows-x64-baseline.zip",
] as const

export const DESKTOP_RELEASE_ASSETS = [
  "mongolgpt-desktop-mac-x64.dmg",
  "mongolgpt-desktop-mac-x64.zip",
  "mongolgpt-desktop-mac-arm64.dmg",
  "mongolgpt-desktop-mac-arm64.zip",
  "mongolgpt-desktop-win-x64.exe",
  "mongolgpt-desktop-win-arm64.exe",
  "mongolgpt-desktop-linux-x64.AppImage",
  "mongolgpt-desktop-linux-x64.deb",
  "mongolgpt-desktop-linux-x64.rpm",
  "mongolgpt-desktop-linux-arm64.AppImage",
  "mongolgpt-desktop-linux-arm64.deb",
  "mongolgpt-desktop-linux-arm64.rpm",
] as const

export const RELEASE_ARTIFACTS = [...CLI_RELEASE_ASSETS, ...DESKTOP_RELEASE_ASSETS].sort()

export type ReleaseFile = {
  name: string
  bytes: Uint8Array
}

export function isReleaseArtifact(name: string) {
  return RELEASE_ARTIFACTS.includes(name as (typeof RELEASE_ARTIFACTS)[number])
}

export function createSha256Sums(files: readonly ReleaseFile[]) {
  const seen = new Set<string>()
  const selected = files.filter((file) => isReleaseArtifact(file.name))
  const missing = RELEASE_ARTIFACTS.filter((name) => !selected.some((file) => file.name === name))
  if (missing.length) throw new Error(`missing release artifacts: ${missing.join(", ")}`)

  for (const file of selected) {
    if (seen.has(file.name)) throw new Error(`duplicate release artifact: ${file.name}`)
    seen.add(file.name)
    if (file.name.includes("/") || file.name.includes("\\"))
      throw new Error(`release asset must be a basename: ${file.name}`)
  }

  return (
    selected
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((file) => `${createHash("sha256").update(file.bytes).digest("hex")}  ${file.name}`)
      .join("\n") + "\n"
  )
}

export function validateReleaseChecksumContract(assetNames: readonly string[], checksumText?: string) {
  const errors: string[] = []
  const names = new Set(assetNames)
  if (!names.has(RELEASE_CHECKSUM_ASSET)) errors.push(`missing ${RELEASE_CHECKSUM_ASSET}`)

  const expected = RELEASE_ARTIFACTS.filter((name) => !names.has(name))
  if (expected.length) errors.push(`missing release artifacts: ${expected.join(", ")}`)
  if (!checksumText) return errors

  const lines = checksumText.split(/\r?\n/).filter(Boolean)
  const actual = new Map<string, string>()
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([^\\/]+)$/.exec(line)
    if (!match) {
      errors.push(`invalid checksum line: ${line}`)
      continue
    }
    const [, hash, name] = match
    if (!isReleaseArtifact(name)) errors.push(`checksum covers non-release asset: ${name}`)
    if (actual.has(name)) errors.push(`duplicate checksum entry: ${name}`)
    actual.set(name, hash)
  }

  const missingChecksums = RELEASE_ARTIFACTS.filter((name) => !actual.has(name))
  if (missingChecksums.length) errors.push(`checksum missing artifacts: ${missingChecksums.join(", ")}`)
  const extraChecksums = Array.from(actual.keys()).filter((name) => !RELEASE_ARTIFACTS.includes(name as any))
  if (extraChecksums.length) errors.push(`checksum has unexpected artifacts: ${extraChecksums.join(", ")}`)
  return errors
}
