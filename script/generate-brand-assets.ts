import { dirname, join, relative, resolve } from "node:path"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import sharp from "sharp"

const root = resolve(import.meta.dir, "..")
const check = process.argv.includes("--check")
const mismatches: string[] = []

const identity = resolve(root, "packages/identity")
const markPath = resolve(identity, "mark.svg")
const wordmarkDarkPath = resolve(identity, "wordmark-dark.svg")
const wordmarkLightPath = resolve(identity, "wordmark-light.svg")
const socialPath = resolve(identity, "social-share.svg")

const [mark, wordmarkDark, wordmarkLight, social] = await Promise.all([
  readFile(markPath),
  readFile(wordmarkDarkPath),
  readFile(wordmarkLightPath),
  readFile(socialPath),
])

async function sameFile(path: string, expected: Uint8Array) {
  try {
    return Buffer.from(await readFile(path)).equals(Buffer.from(expected))
  } catch {
    return false
  }
}

async function output(path: string, expected: Uint8Array) {
  if (check) {
    if (!(await sameFile(path, expected))) mismatches.push(relative(root, path))
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, expected)
}

async function png(svg: Uint8Array, width: number, height = width) {
  return sharp(svg).resize(width, height, { fit: "contain" }).png({ compressionLevel: 9 }).toBuffer()
}

async function pngSize(path: string) {
  const buffer = await readFile(path)
  if (buffer.length < 24 || buffer.subarray(1, 4).toString() !== "PNG") {
    throw new Error(`PNG биш generated asset: ${relative(root, path)}`)
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

async function files(path: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name)
    if (entry.isDirectory()) result.push(...(await files(target)))
    if (entry.isFile()) result.push(target)
  }
  return result
}

const browserRoots = [
  resolve(root, "packages/ui/src/assets/favicon"),
  resolve(root, "packages/app/public"),
  resolve(root, "packages/web/public"),
  resolve(root, "packages/console/app/public"),
  resolve(root, "packages/enterprise/public"),
]

const browserPngs = {
  "favicon-96x96.png": 96,
  "favicon-96x96-v3.png": 96,
  "apple-touch-icon.png": 180,
  "apple-touch-icon-v3.png": 180,
  "web-app-manifest-192x192.png": 192,
  "web-app-manifest-512x512.png": 512,
} as const

const rendered = new Map<string, Buffer>()
async function markPng(size: number) {
  const key = String(size)
  const cached = rendered.get(key)
  if (cached) return cached
  const value = await png(mark, size)
  rendered.set(key, value)
  return value
}

for (const dir of browserRoots) {
  await output(resolve(dir, "favicon.svg"), mark)
  await output(resolve(dir, "favicon-v3.svg"), mark)
  for (const [name, size] of Object.entries(browserPngs)) {
    await output(resolve(dir, name), await markPng(size))
  }
}

await output(resolve(identity, "mark-light.svg"), mark)
await output(resolve(identity, "mark-96x96.png"), await markPng(96))
await output(resolve(identity, "mark-192x192.png"), await markPng(192))
await output(resolve(identity, "mark-512x512.png"), await markPng(512))
await output(resolve(identity, "mark-512x512-light.png"), await markPng(512))

const markSvgTargets = [
  "packages/console/app/src/asset/brand/mongolgpt-logo-dark.svg",
  "packages/console/app/src/asset/brand/mongolgpt-logo-dark-square.svg",
  "packages/console/app/src/asset/brand/mongolgpt-logo-light.svg",
  "packages/console/app/src/asset/brand/mongolgpt-logo-light-square.svg",
  "packages/console/app/src/asset/lander/logo-dark.svg",
  "packages/console/app/src/asset/lander/logo-light.svg",
  "packages/console/app/src/asset/lander/mongolgpt-logo-dark.svg",
  "packages/console/app/src/asset/lander/mongolgpt-logo-light.svg",
]
for (const target of markSvgTargets) await output(resolve(root, target), mark)

const darkWordmarks = [
  "packages/web/src/assets/logo-dark.svg",
  "packages/web/src/assets/logo-ornate-dark.svg",
  "packages/stats/app/src/asset/logo-ornate-dark.svg",
  "packages/console/app/src/asset/logo-ornate-dark.svg",
  "packages/console/app/src/asset/brand/mongolgpt-wordmark-dark.svg",
  "packages/console/app/src/asset/brand/mongolgpt-wordmark-simple-dark.svg",
  "packages/console/app/src/asset/lander/wordmark-dark.svg",
  "packages/console/app/src/asset/lander/mongolgpt-wordmark-dark.svg",
]
const lightWordmarks = [
  "packages/web/src/assets/logo-light.svg",
  "packages/web/src/assets/logo-ornate-light.svg",
  "packages/stats/app/src/asset/logo-ornate-light.svg",
  "packages/console/app/src/asset/logo.svg",
  "packages/console/app/src/asset/logo-ornate-light.svg",
  "packages/console/app/src/asset/brand/mongolgpt-wordmark-light.svg",
  "packages/console/app/src/asset/brand/mongolgpt-wordmark-simple-light.svg",
  "packages/console/app/src/asset/lander/wordmark-light.svg",
  "packages/console/app/src/asset/lander/mongolgpt-wordmark-light.svg",
]
for (const target of darkWordmarks) await output(resolve(root, target), wordmarkDark)
for (const target of lightWordmarks) await output(resolve(root, target), wordmarkLight)

const brandMarkPngs = [
  "packages/console/app/src/asset/brand/mongolgpt-logo-dark.png",
  "packages/console/app/src/asset/brand/mongolgpt-logo-dark-square.png",
  "packages/console/app/src/asset/brand/mongolgpt-logo-light.png",
  "packages/console/app/src/asset/brand/mongolgpt-logo-light-square.png",
  "packages/console/app/src/asset/brand/preview-mongolgpt-logo-dark.png",
  "packages/console/app/src/asset/brand/preview-mongolgpt-logo-dark-square.png",
  "packages/console/app/src/asset/brand/preview-mongolgpt-logo-light.png",
  "packages/console/app/src/asset/brand/preview-mongolgpt-logo-light-square.png",
]
for (const target of brandMarkPngs) await output(resolve(root, target), await markPng(300))

for (const target of [
  "packages/console/app/src/asset/lander/desktop-app-icon.png",
  "packages/console/app/src/asset/lander/mongolgpt-desktop-icon.png",
]) {
  await output(resolve(root, target), await markPng(512))
}

await output(
  resolve(root, "packages/console/mail/emails/templates/static/logo.png"),
  await png(wordmarkLight, 669, 120),
)

const socialPng = await png(social, 1200, 630)
for (const target of [
  "packages/ui/src/assets/images/social-share.png",
  "packages/app/public/social-share.png",
  "packages/web/public/social-share.png",
  "packages/console/app/public/social-share.png",
  "packages/enterprise/public/social-share.png",
]) {
  await output(resolve(root, target), socialPng)
}

const desktopDirs = [
  resolve(root, "packages/desktop/icons/dev"),
  resolve(root, "packages/desktop/icons/beta"),
  resolve(root, "packages/desktop/icons/prod"),
  resolve(root, "packages/desktop/resources/icons"),
]
for (const dir of desktopDirs) {
  await output(resolve(dir, "icon.svg"), mark)
  for (const target of (await files(dir)).filter((path) => path.toLowerCase().endsWith(".png"))) {
    const { width, height } = await pngSize(target)
    await output(target, await png(mark, width, height))
  }
}

async function ico() {
  const images = await Promise.all([16, 32, 48, 64, 128, 256].map(markPng))
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((image, index) => {
    const size = [16, 32, 48, 64, 128, 256][index]
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(image.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += image.length
  })
  return Buffer.concat([header, ...images])
}

const windowsIcon = await ico()
for (const dir of browserRoots) {
  await output(resolve(dir, "favicon.ico"), windowsIcon)
  await output(resolve(dir, "favicon-v3.ico"), windowsIcon)
}
for (const dir of desktopDirs) await output(resolve(dir, "icon.ico"), windowsIcon)

function crc32(input: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(entries: Array<{ name: string; data: Uint8Array }>) {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0x0800, 8)
    directory.writeUInt32LE(crc, 16)
    directory.writeUInt32LE(data.length, 20)
    directory.writeUInt32LE(data.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

const brandArchive = storedZip([
  { name: "mongolgpt-mark.svg", data: mark },
  { name: "mongolgpt-wordmark-dark.svg", data: wordmarkDark },
  { name: "mongolgpt-wordmark-light.svg", data: wordmarkLight },
  { name: "mongolgpt-mark-512.png", data: await markPng(512) },
  { name: "mongolgpt-social-share.png", data: socialPng },
])
for (const target of [
  "packages/console/app/public/mongolgpt-brand-assets.zip",
  "packages/console/app/src/asset/brand/mongolgpt-brand-assets.zip",
]) {
  await output(resolve(root, target), brandArchive)
}

if (mismatches.length) {
  console.error("Brand asset canonical source-оос зөрсөн байна:")
  for (const path of mismatches) console.error(`- ${path}`)
  process.exit(1)
}

console.log(check ? "Brand asset parity: OK" : "MongolGPT brand asset-ууд шинэчлэгдлээ")
