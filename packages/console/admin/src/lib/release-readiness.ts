import { z } from "zod"

export const RELEASE_READINESS_REPOSITORY = "sergei10a-rgb/mongolgpt"
export const RELEASE_READINESS_PACKAGES = ["mongolgpt", "@mongolgpt/sdk", "@mongolgpt/plugin", "@mongolgpt/ui"] as const
export const RELEASE_READINESS_CLI_ASSETS = [
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
export const RELEASE_READINESS_DESKTOP_ASSETS = [
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
export const RELEASE_READINESS_ARTIFACTS = [
  ...RELEASE_READINESS_CLI_ASSETS,
  ...RELEASE_READINESS_DESKTOP_ASSETS,
] as const
export const RELEASE_READINESS_CHECKSUM = "SHA256SUMS"

const releaseVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const MAX_RELEASE_JSON_BYTES = 1024 * 1024
const MAX_RELEASE_METADATA_BYTES = 512 * 1024
const PUBLIC_RELEASE_CACHE_TTL_SECONDS = 5 * 60

const releaseSchema = z
  .object({
    tag_name: z.string().trim().min(1).max(255),
    draft: z.boolean(),
    prerelease: z.boolean(),
    body: z.string().max(MAX_RELEASE_JSON_BYTES).nullable(),
    assets: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(255),
            size: z.number().int().nonnegative(),
            state: z.string().trim().min(1).max(64),
          })
          .passthrough(),
      )
      .max(100),
  })
  .passthrough()

const npmPackageSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    version: z.string().trim().min(1).max(255),
    bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
    dist: z
      .object({
        tarball: z.string().url().max(2048),
        integrity: z.string().trim().min(1).max(1024),
      })
      .passthrough(),
  })
  .passthrough()

const releaseNotesHeadings = [
  "## Өөрчлөлтийн жагсаалт",
  "## Суулгах",
  "## Шинэчлэх",
  "## Файлын бүрэн бүтэн байдал",
] as const

const updaterPlatforms = {
  "windows-x86_64-nsis": "mongolgpt-desktop-win-x64.exe",
  "windows-aarch64-nsis": "mongolgpt-desktop-win-arm64.exe",
  "darwin-x86_64-app": "mongolgpt-desktop-mac-x64.app.tar.gz",
  "darwin-aarch64-app": "mongolgpt-desktop-mac-arm64.app.tar.gz",
  "linux-x86_64-deb": "mongolgpt-desktop-linux-x64.deb",
  "linux-x86_64-rpm": "mongolgpt-desktop-linux-x64.rpm",
  "linux-x86_64-appimage": "mongolgpt-desktop-linux-x64.AppImage",
  "linux-aarch64-deb": "mongolgpt-desktop-linux-arm64.deb",
  "linux-aarch64-rpm": "mongolgpt-desktop-linux-arm64.rpm",
  "linux-aarch64-appimage": "mongolgpt-desktop-linux-arm64.AppImage",
  "windows-x86_64": "mongolgpt-desktop-win-x64.exe",
  "windows-aarch64": "mongolgpt-desktop-win-arm64.exe",
  "darwin-x86_64": "mongolgpt-desktop-mac-x64.app.tar.gz",
  "darwin-aarch64": "mongolgpt-desktop-mac-arm64.app.tar.gz",
  "linux-x86_64": "mongolgpt-desktop-linux-x64.deb",
  "linux-aarch64": "mongolgpt-desktop-linux-arm64.deb",
} as const

type ReleasePackageName = (typeof RELEASE_READINESS_PACKAGES)[number]
type ReleaseChannel = "beta" | "latest"
type UpdaterMetadataKind = "windows" | "linuxX64" | "linuxArm64" | "mac"

export type PublishedReleaseEvidence = {
  version: string
  channel: ReleaseChannel
  release: z.output<typeof releaseSchema> | null
  checksumText?: string
  latestJson?: string
  metadata: Partial<Record<UpdaterMetadataKind, string>>
  packages: Record<ReleasePackageName, z.output<typeof npmPackageSchema> | null>
}

type ReleaseFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function releaseTag(version: string) {
  const normalized = version.trim()
  if (version !== normalized || !releaseVersionPattern.test(normalized)) {
    throw new Error("MongolGPT release хувилбар буруу байна")
  }
  return `mongolgpt-v${normalized}`
}

export function releaseUpdaterMetadataAssets(channel: ReleaseChannel) {
  return {
    json: "latest.json",
    windows: `${channel}.yml`,
    linuxX64: `${channel}-linux.yml`,
    linuxArm64: `${channel}-linux-arm64.yml`,
    mac: `${channel}-mac.yml`,
  } as const
}

export async function collectPublishedReleaseEvidence(input: {
  version: string
  fetcher?: ReleaseFetcher
}): Promise<PublishedReleaseEvidence> {
  const version = input.version.trim()
  const tag = releaseTag(version)
  const channel: ReleaseChannel = version.includes("-") ? "beta" : "latest"
  const fetcher = input.fetcher ?? fetch
  const packageTag = channel
  const githubUrl = `https://api.github.com/repos/${RELEASE_READINESS_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`

  const [release, packageEntries] = await Promise.all([
    fetchOptionalJson(githubUrl, releaseSchema, fetcher, {
      Accept: "application/vnd.github+json",
      "User-Agent": "mongolgpt-admin-readiness",
      "X-GitHub-Api-Version": "2022-11-28",
    }),
    Promise.all(
      RELEASE_READINESS_PACKAGES.map(async (name) => {
        const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${packageTag}`
        const value = await fetchOptionalJson(url, npmPackageSchema, fetcher, {
          Accept: "application/json",
          "User-Agent": "mongolgpt-admin-readiness",
        })
        return [name, value] as const
      }),
    ),
  ])

  const packages = Object.fromEntries(packageEntries) as PublishedReleaseEvidence["packages"]
  const metadataAssets = releaseUpdaterMetadataAssets(channel)
  const names = new Set(release?.assets.map((asset) => asset.name) ?? [])
  const metadataEntries = await Promise.all(
    Object.entries(metadataAssets).map(async ([kind, name]) => {
      if (!names.has(name)) return [kind, undefined] as const
      const url = `https://github.com/${RELEASE_READINESS_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
      return [kind, await fetchOptionalText(url, fetcher)] as const
    }),
  )
  const texts = Object.fromEntries(metadataEntries) as Partial<
    Record<keyof ReturnType<typeof releaseUpdaterMetadataAssets>, string>
  >
  const checksumText = names.has(RELEASE_READINESS_CHECKSUM)
    ? await fetchOptionalText(
        `https://github.com/${RELEASE_READINESS_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${RELEASE_READINESS_CHECKSUM}`,
        fetcher,
      )
    : undefined

  return {
    version,
    channel,
    release,
    checksumText,
    latestJson: texts.json,
    metadata: {
      windows: texts.windows,
      linuxX64: texts.linuxX64,
      linuxArm64: texts.linuxArm64,
      mac: texts.mac,
    },
    packages,
  }
}

export function validatePublishedReleaseEvidence(evidence: PublishedReleaseEvidence) {
  const errors: string[] = []
  const tag = releaseTag(evidence.version)
  const release = evidence.release
  if (!release) {
    errors.push("github-release-missing")
  } else {
    if (release.tag_name !== tag) errors.push("github-release-tag")
    if (release.draft) errors.push("github-release-draft")
    if (release.prerelease !== (evidence.channel === "beta")) errors.push("github-release-channel")

    const names = new Set<string>()
    for (const asset of release.assets) {
      if (names.has(asset.name)) errors.push(`release-asset-duplicate:${asset.name}`)
      names.add(asset.name)
      if (asset.state !== "uploaded" || asset.size <= 0) errors.push(`release-asset-invalid:${asset.name}`)
    }
    for (const name of requiredReleaseAssets(evidence.channel)) {
      if (!names.has(name)) errors.push(`release-asset-missing:${name}`)
    }

    const body = release.body?.trim() ?? ""
    for (const heading of releaseNotesHeadings) {
      if (!body.includes(heading)) errors.push(`release-notes-heading:${heading}`)
    }
    if (!body.includes(`mongolgpt@${evidence.version}`)) errors.push("release-notes-npm-version")
    if (!body.includes(`mongolgpt upgrade ${evidence.version}`)) errors.push("release-notes-upgrade-version")
    if (!body.includes(RELEASE_READINESS_CHECKSUM)) errors.push("release-notes-checksum")
  }

  validateChecksum(evidence.checksumText, errors)
  validateLatestJson(evidence, errors)
  validateUpdaterYml(evidence, errors)
  validatePackages(evidence, errors)
  return errors
}

function requiredReleaseAssets(channel: ReleaseChannel) {
  return [
    ...RELEASE_READINESS_ARTIFACTS,
    RELEASE_READINESS_CHECKSUM,
    ...Object.values(releaseUpdaterMetadataAssets(channel)),
  ]
}

function validateChecksum(text: string | undefined, errors: string[]) {
  if (!text) {
    errors.push("release-checksum-missing")
    return
  }
  const entries = new Map<string, string>()
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  ([^\\/]+)$/.exec(line)
    if (!match) {
      errors.push("release-checksum-line")
      continue
    }
    const [, hash, name] = match
    if (entries.has(name)) errors.push(`release-checksum-duplicate:${name}`)
    entries.set(name, hash)
  }
  for (const name of RELEASE_READINESS_ARTIFACTS) {
    if (!entries.has(name)) errors.push(`release-checksum-artifact:${name}`)
  }
}

function validateLatestJson(evidence: PublishedReleaseEvidence, errors: string[]) {
  if (!evidence.latestJson) {
    errors.push("updater-json-missing")
    return
  }
  let value: unknown
  try {
    value = JSON.parse(evidence.latestJson)
  } catch {
    errors.push("updater-json-invalid")
    return
  }
  if (!record(value)) {
    errors.push("updater-json-invalid")
    return
  }
  if (value.version !== evidence.version) errors.push("updater-json-version")
  if (typeof value.notes !== "string" || value.notes.trim() !== evidence.release?.body?.trim()) {
    errors.push("updater-json-notes")
  }
  if (typeof value.pub_date !== "string" || !Number.isFinite(Date.parse(value.pub_date))) {
    errors.push("updater-json-date")
  }
  if (!record(value.platforms)) {
    errors.push("updater-json-platforms")
    return
  }
  for (const [platform, asset] of Object.entries(updaterPlatforms)) {
    const item = value.platforms[platform]
    if (!record(item)) {
      errors.push(`updater-json-platform:${platform}`)
      continue
    }
    const expectedUrl = `https://github.com/${RELEASE_READINESS_REPOSITORY}/releases/download/${releaseTag(evidence.version)}/${asset}`
    if (item.url !== expectedUrl) errors.push(`updater-json-url:${platform}`)
    if (typeof item.signature !== "string" || item.signature.trim().length < 32 || /\s/.test(item.signature)) {
      errors.push(`updater-json-signature:${platform}`)
    }
  }
}

function validateUpdaterYml(evidence: PublishedReleaseEvidence, errors: string[]) {
  const expected: Record<UpdaterMetadataKind, readonly string[]> = {
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
  for (const kind of Object.keys(expected) as UpdaterMetadataKind[]) {
    const text = evidence.metadata[kind]
    if (!text) {
      errors.push(`updater-yml-missing:${kind}`)
      continue
    }
    if (text.match(/^version:\s*([^\s]+)\s*$/m)?.[1] !== evidence.version) {
      errors.push(`updater-yml-version:${kind}`)
    }
    const files = ymlFiles(text)
    for (const asset of expected[kind]) {
      if (!files.some((file) => file.url === asset)) errors.push(`updater-yml-asset:${kind}:${asset}`)
    }
    for (const file of files) {
      if (!expected[kind].includes(file.url)) errors.push(`updater-yml-extra:${kind}:${file.url}`)
      if (!file.sha512 || file.sha512.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.sha512)) {
        errors.push(`updater-yml-sha512:${kind}:${file.url}`)
      }
      if (!Number.isSafeInteger(file.size) || (file.size ?? 0) <= 0) {
        errors.push(`updater-yml-size:${kind}:${file.url}`)
      }
      if (file.blockMapSize !== undefined && (!Number.isSafeInteger(file.blockMapSize) || file.blockMapSize <= 0)) {
        errors.push(`updater-yml-blockmap:${kind}:${file.url}`)
      }
    }
  }
}

function validatePackages(evidence: PublishedReleaseEvidence, errors: string[]) {
  for (const name of RELEASE_READINESS_PACKAGES) {
    const pkg = evidence.packages[name]
    if (!pkg) {
      errors.push(`npm-package-missing:${name}`)
      continue
    }
    if (pkg.name !== name || pkg.version !== evidence.version) errors.push(`npm-package-version:${name}`)
    if (!pkg.dist.integrity.startsWith("sha512-")) errors.push(`npm-package-integrity:${name}`)
    let tarball: URL | undefined
    try {
      tarball = new URL(pkg.dist.tarball)
    } catch {
      errors.push(`npm-package-tarball:${name}`)
    }
    if (tarball?.protocol !== "https:" || tarball?.hostname !== "registry.npmjs.org") {
      errors.push(`npm-package-tarball:${name}`)
    }
    if (name === "mongolgpt") {
      const command = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.mongolgpt
      if (!command?.trim()) errors.push("npm-package-bin:mongolgpt")
    }
  }
}

async function fetchOptionalJson<T extends z.ZodType>(
  url: string,
  schema: T,
  fetcher: ReleaseFetcher,
  headers: Record<string, string>,
): Promise<z.output<T> | null> {
  const response = await fetcher(url, {
    ...publicReleaseRequest(headers),
  })
  if (response.status === 404) return null
  if (!response.ok || !jsonResponse(response)) throw new Error("Release JSON шалгалт амжилтгүй боллоо")
  const text = await readBoundedText(response, MAX_RELEASE_JSON_BYTES)
  const parsed = schema.safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error("Release JSON бүтэц буруу байна")
  return parsed.data
}

async function fetchOptionalText(url: string, fetcher: ReleaseFetcher) {
  const response = await fetcher(url, {
    ...publicReleaseRequest({
      Accept: "application/octet-stream, application/json, text/plain",
      "User-Agent": "mongolgpt-admin-readiness",
    }),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error("Release metadata шалгалт амжилтгүй боллоо")
  return readBoundedText(response, MAX_RELEASE_METADATA_BYTES)
}

async function readBoundedText(response: Response, maximum: number) {
  const contentLength = response.headers.get("content-length")
  if (contentLength) {
    const value = Number(contentLength)
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("Release хариу хэт том байна")
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    size += item.value.byteLength
    if (size > maximum) {
      await reader.cancel()
      throw new Error("Release хариу хэт том байна")
    }
    chunks.push(item.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

function jsonResponse(response: Response) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
}

function publicReleaseRequest(headers: Record<string, string>) {
  return {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(4_000),
    cf: {
      cacheEverything: true,
      cacheTtl: PUBLIC_RELEASE_CACHE_TTL_SECONDS,
    },
  } as RequestInit
}

type YmlFile = { url: string; sha512?: string; size?: number; blockMapSize?: number }

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

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
