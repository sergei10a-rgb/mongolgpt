import { createHash } from "node:crypto"

export const RELEASE_CHECKSUM_ASSET = "SHA256SUMS"
const releaseVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function releaseTag(version: string) {
  if (version !== version.trim() || !releaseVersionPattern.test(version)) {
    throw new Error(`invalid MongolGPT release version: ${version}`)
  }
  return `mongolgpt-v${version}`
}

export const RELEASE_NOTES_HEADINGS = [
  "## Өөрчлөлтийн жагсаалт",
  "## Суулгах",
  "## Шинэчлэх",
  "## Файлын бүрэн бүтэн байдал",
] as const

function normalizeChangelog(changelog: string) {
  const body = changelog
    .trim()
    .replace(/^#\s+[^\n]+\n+/, "")
    .trim()
  return body || "- Энэ хувилбарт хэрэглэгчид харагдах онцлох өөрчлөлт байхгүй."
}

export function createReleaseNotes(version: string, changelog: string) {
  const tag = releaseTag(version)
  return [
    RELEASE_NOTES_HEADINGS[0],
    "",
    normalizeChangelog(changelog),
    "",
    RELEASE_NOTES_HEADINGS[1],
    "",
    `- Desktop болон CLI файлуудыг [${tag} хувилбарын хуудас](https://github.com/sergei10a-rgb/mongolgpt/releases/tag/${tag})-аас татна.`,
    `- npm CLI: \`npm install -g mongolgpt@${version}\``,
    "- Суулгах дэлгэрэнгүй заавар: https://docs.mgpt.mn/install/",
    "",
    RELEASE_NOTES_HEADINGS[2],
    "",
    `- CLI: \`mongolgpt upgrade ${version}\``,
    "- Desktop: Тохиргоо доторх шинэчлэлт шалгах үйлдлийг ашиглана. Шинэчлэлт татагдсаны дараа суулгаж дахин нээнэ.",
    "",
    RELEASE_NOTES_HEADINGS[3],
    "",
    `- Release-ийн \`${RELEASE_CHECKSUM_ASSET}\` файлыг татаж, суулгагч эсвэл CLI архивын SHA-256 утгыг тулгана.`,
    `- Linux/macOS: \`sha256sum <татсан-файл>\` гэж бодоод, гарсан утгыг \`${RELEASE_CHECKSUM_ASSET}\` доторх тухайн файлын мөртэй тулгана.`,
    `- Windows PowerShell: \`Get-FileHash -Algorithm SHA256 <татсан-файл>\``,
    "",
  ].join("\n")
}

export function validateReleaseNotesContract(body: string | null | undefined, version: string) {
  const errors: string[] = []
  const text = body?.trim() ?? ""
  if (!text) return ["release notes are empty"]

  for (const heading of RELEASE_NOTES_HEADINGS) {
    if (!text.includes(heading)) errors.push(`release notes missing heading: ${heading}`)
  }
  if (!text.includes(`mongolgpt@${version}`)) errors.push(`release notes missing npm install version: ${version}`)
  if (!text.includes(`mongolgpt upgrade ${version}`))
    errors.push(`release notes missing CLI upgrade version: ${version}`)
  if (!text.includes(RELEASE_CHECKSUM_ASSET)) errors.push(`release notes missing ${RELEASE_CHECKSUM_ASSET} guidance`)
  return errors
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
  "mongolgpt-desktop-mac-x64.app.tar.gz",
  "mongolgpt-desktop-mac-arm64.app.tar.gz",
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
const releaseArtifactNames = new Set<string>(RELEASE_ARTIFACTS)

export type ReleaseFile = {
  name: string
  bytes: Uint8Array
}

export function isReleaseArtifact(name: string) {
  return releaseArtifactNames.has(name)
}

export function isChecksummedReleaseAsset(name: string) {
  return isReleaseArtifact(name) || /^mongolgpt-desktop-.+\.blockmap$/.test(name)
}

export function createSha256Sums(files: readonly ReleaseFile[]) {
  const seen = new Set<string>()
  const selected = files.filter((file) => isChecksummedReleaseAsset(file.name))
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
    if (!isChecksummedReleaseAsset(name)) errors.push(`checksum covers non-release asset: ${name}`)
    if (actual.has(name)) errors.push(`duplicate checksum entry: ${name}`)
    actual.set(name, hash)
  }

  const expectedChecksums = assetNames.filter(isChecksummedReleaseAsset)
  const missingChecksums = expectedChecksums.filter((name) => !actual.has(name))
  if (missingChecksums.length) errors.push(`checksum missing artifacts: ${missingChecksums.join(", ")}`)
  const extraChecksums = Array.from(actual.keys()).filter((name) => !expectedChecksums.includes(name))
  if (extraChecksums.length) errors.push(`checksum has unexpected artifacts: ${extraChecksums.join(", ")}`)
  return errors
}

export type ReleaseUpdaterChannel = "beta" | "latest"

export function resolveReleaseUpdaterChannel(value: string | undefined, version: string): ReleaseUpdaterChannel {
  if (value === undefined || value === "") return version.includes("-") ? "beta" : "latest"
  if (value === "beta") return "beta"
  if (value === "latest" || value === "prod") return "latest"
  throw new Error(`invalid MongolGPT release updater channel: ${value}`)
}

export function releaseUpdaterMetadataAssets(channel: ReleaseUpdaterChannel) {
  return {
    windows: `${channel}.yml`,
    linuxX64: `${channel}-linux.yml`,
    linuxArm64: `${channel}-linux-arm64.yml`,
    mac: `${channel}-mac.yml`,
  } as const
}

function ymlVersion(text: string) {
  return text.match(/^version:\s*([^\s]+)\s*$/m)?.[1]
}

type YmlFile = {
  url: string
  sha512?: string
  size?: number
  blockMapSize?: number
}

function ymlFiles(text: string) {
  const files: YmlFile[] = []
  let current: YmlFile | undefined
  const flush = () => {
    if (current) files.push(current)
    current = undefined
  }

  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (value.startsWith("- url:")) {
      flush()
      current = { url: value.slice("- url:".length).trim() }
    } else if (current && value.startsWith("sha512:")) {
      current.sha512 = value.slice("sha512:".length).trim()
    } else if (current && value.startsWith("size:")) {
      current.size = Number(value.slice("size:".length).trim())
    } else if (current && value.startsWith("blockMapSize:")) {
      current.blockMapSize = Number(value.slice("blockMapSize:".length).trim())
    }
  }
  flush()
  return files
}

export function validateUpdaterReleaseContract(input: {
  version: string
  channel: ReleaseUpdaterChannel
  assetNames: readonly string[]
  releaseBody?: string | null
  metadata?: Partial<Record<"windows" | "linuxX64" | "linuxArm64" | "mac", string>>
}) {
  const errors = validateReleaseNotesContract(input.releaseBody, input.version)
  const names = new Set(input.assetNames)
  const metadataAssets = releaseUpdaterMetadataAssets(input.channel)

  for (const name of Object.values(metadataAssets)) {
    if (!names.has(name)) errors.push(`missing updater metadata: ${name}`)
  }

  const expectedYml: Record<keyof NonNullable<typeof input.metadata>, readonly string[]> = {
    windows: ["mongolgpt-desktop-win-arm64.exe", "mongolgpt-desktop-win-x64.exe"],
    linuxX64: [
      "mongolgpt-desktop-linux-x64.AppImage",
      "mongolgpt-desktop-linux-x64.deb",
      "mongolgpt-desktop-linux-x64.rpm",
    ],
    linuxArm64: [
      "mongolgpt-desktop-linux-arm64.AppImage",
      "mongolgpt-desktop-linux-arm64.deb",
      "mongolgpt-desktop-linux-arm64.rpm",
    ],
    mac: ["mongolgpt-desktop-mac-arm64.zip", "mongolgpt-desktop-mac-x64.zip"],
  }

  const metadataKinds = ["windows", "linuxX64", "linuxArm64", "mac"] as const
  for (const kind of metadataKinds) {
    const expected = expectedYml[kind]
    const text = input.metadata?.[kind]
    const filename = metadataAssets[kind]
    if (!text) {
      if (names.has(filename)) errors.push(`updater metadata content missing: ${filename}`)
      continue
    }
    const actualVersion = ymlVersion(text)
    if (actualVersion !== input.version)
      errors.push(
        `updater metadata version mismatch in ${filename}: expected ${input.version}, got ${actualVersion ?? "missing"}`,
      )
    const files = ymlFiles(text)
    for (const asset of expected) {
      if (!files.some((file) => file.url === asset)) errors.push(`updater metadata ${filename} missing asset: ${asset}`)
    }
    for (const file of files) {
      if (!expected.includes(file.url)) errors.push(`updater metadata ${filename} has unexpected asset: ${file.url}`)
      const sha512 = file.sha512 ?? ""
      if (sha512.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sha512))
        errors.push(`updater metadata ${filename} has invalid sha512: ${file.url}`)
      if (!Number.isSafeInteger(file.size) || (file.size ?? 0) <= 0)
        errors.push(`updater metadata ${filename} has invalid size: ${file.url}`)
      if (file.blockMapSize !== undefined && (!Number.isSafeInteger(file.blockMapSize) || file.blockMapSize <= 0))
        errors.push(`updater metadata ${filename} has invalid blockMapSize: ${file.url}`)
    }
  }

  return errors
}
