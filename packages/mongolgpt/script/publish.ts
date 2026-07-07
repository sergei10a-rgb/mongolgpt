#!/usr/bin/env bun
import { $ } from "bun"
import fs from "fs"
import pkg from "../package.json"
import { Script } from "@mongolgpt/script"
import { fileURLToPath } from "url"
import path from "path"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const dryRun = process.argv.includes("--dry-run")
const npmOnly = process.argv.includes("--npm-only") || process.argv.includes("--skip-registries")
const releaseTag = `mongolgpt-v${Script.version}`

const expectedBinaryPackages = [
  "mongolgpt-linux-arm64",
  "mongolgpt-linux-x64",
  "mongolgpt-linux-x64-baseline",
  "mongolgpt-linux-arm64-musl",
  "mongolgpt-linux-x64-musl",
  "mongolgpt-linux-x64-baseline-musl",
  "mongolgpt-darwin-arm64",
  "mongolgpt-darwin-x64",
  "mongolgpt-darwin-x64-baseline",
  "mongolgpt-windows-arm64",
  "mongolgpt-windows-x64",
  "mongolgpt-windows-x64-baseline",
]

function binaryName(name: string) {
  return name.includes("-windows-") ? "mongolgpt.exe" : "mongolgpt"
}

async function assertBinaryPackages() {
  if (!fs.existsSync("./dist")) throw new Error("dist directory is missing; run script/build.ts before publishing")

  const seenPackageJsons = new Set<string>()
  for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
    seenPackageJsons.add(filepath.split(/[\\/]/)[0]!)
  }

  const extras = Array.from(seenPackageJsons).filter((name) => name !== pkg.name && !expectedBinaryPackages.includes(name))
  if (extras.length) throw new Error(`unexpected package directories in dist: ${extras.join(", ")}`)

  const binaries: Record<string, string> = {}
  for (const name of expectedBinaryPackages) {
    const packageDir = path.join("./dist", name)
    const packagePath = path.join(packageDir, "package.json")
    if (!fs.existsSync(packagePath)) throw new Error(`missing ${packagePath}`)

    const binaryPath = path.join(packageDir, "bin", binaryName(name))
    if (!fs.existsSync(binaryPath)) throw new Error(`missing ${binaryPath}`)
    const stat = fs.statSync(binaryPath)
    if (!stat.isFile() || stat.size < 1_000_000) throw new Error(`invalid binary artifact ${binaryPath}`)

    const metadata = await Bun.file(packagePath).json()
    if (metadata.name !== name) throw new Error(`${packagePath} has name ${metadata.name}, expected ${name}`)
    if (!metadata.version) throw new Error(`${packagePath} is missing version`)
    binaries[name] = metadata.version
  }

  const versions = new Set(Object.values(binaries))
  if (versions.size !== 1) throw new Error(`binary package versions differ: ${Array.from(versions).join(", ")}`)

  return binaries
}

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.quiet().nothrow()).exitCode === 0
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".tgz")) fs.rmSync(path.join(dir, file), { force: true })
  }
  if (dryRun) {
    const alreadyPublished = await published(name, version)
    if (alreadyPublished) console.log(`[dry-run] already published ${name}@${version}`)
    await $`npm pack --dry-run --json`.cwd(dir)
    console.log(`[dry-run] would publish ${name}@${version} with tag ${Script.channel}`)
    return
  }
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  const tarball = `${name}-${version}.tgz`
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await $`npm publish ${tarball} --access public --tag ${Script.channel}`.cwd(dir)
      return
    } catch (error) {
      if (await published(name, version)) {
        console.log(`already published ${name}@${version}`)
        return
      }

      const stderr = String((error as any)?.stderr ?? "")
      const retryable = stderr.includes("E429") || stderr.toLowerCase().includes("rate limit")
      if (!retryable || attempt === 5) throw error

      const delay = attempt * 60_000
      console.log(`rate limited while publishing ${name}@${version}; retrying in ${delay / 1000}s`)
      await sleep(delay)
    }
  }
}

const binaries = await assertBinaryPackages()
console.log("binaries", binaries)
const version = Object.values(binaries)[0]

await $`mkdir -p ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${pkg.name}/bin/${pkg.name}.exe`).write(
  [
    `echo "Error: ${pkg.name}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${pkg.name} && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${pkg.name} without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      bin: {
        [pkg.name]: `bin/${pkg.name}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

for (const [name, version] of Object.entries(binaries)) {
  await publish(`./dist/${name}`, name, version)
}
await publish(`./dist/${pkg.name}`, pkg.name, version)

const image = "ghcr.io/sergei10a-rgb/mongolgpt"
const platforms = "linux/amd64,linux/arm64"
const tags = [`${image}:${version}`, `${image}:${Script.channel}`]
const tagFlags = tags.flatMap((t) => ["-t", t])

// registries
if (!Script.preview && !dryRun && !npmOnly) {
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
  // Calculate SHA values
  const arm64Sha = await $`sha256sum ./dist/mongolgpt-linux-arm64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/mongolgpt-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/mongolgpt-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/mongolgpt-darwin-arm64.zip | cut -d' ' -f1`.text().then((x) => x.trim())

  const [pkgver, _subver = ""] = Script.version.split(/(-.*)/, 2)

  // arch
  const binaryPkgbuild = [
    "# Maintainer: MongolGPT <hello@mongolgpt.duckdns.org>",
    "",
    "pkgname='mongolgpt-bin'",
    `pkgver=${pkgver}`,
    `_subver=${_subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='Mongolian-first AI coding agent built for the terminal.'",
    "url='https://github.com/sergei10a-rgb/mongolgpt'",
    "arch=('aarch64' 'x86_64')",
    "license=('MIT')",
    "provides=('mongolgpt')",
    "conflicts=('mongolgpt')",
    "depends=('ripgrep')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/sergei10a-rgb/mongolgpt/releases/download/mongolgpt-v\${pkgver}\${_subver}/mongolgpt-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${arm64Sha}')`,

    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/sergei10a-rgb/mongolgpt/releases/download/mongolgpt-v\${pkgver}\${_subver}/mongolgpt-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./mongolgpt "${pkgdir}/usr/bin/mongolgpt"',
    "}",
    "",
  ].join("\n")

  for (const [pkg, pkgbuild] of [["mongolgpt-bin", binaryPkgbuild]]) {
    for (let i = 0; i < 30; i++) {
      try {
        await $`rm -rf ./dist/aur-${pkg}`
        await $`git clone ssh://aur@aur.archlinux.org/${pkg}.git ./dist/aur-${pkg}`
        await $`cd ./dist/aur-${pkg} && git checkout master`
        await Bun.file(`./dist/aur-${pkg}/PKGBUILD`).write(pkgbuild)
        await $`cd ./dist/aur-${pkg} && makepkg --printsrcinfo > .SRCINFO`
        await $`cd ./dist/aur-${pkg} && git add PKGBUILD .SRCINFO`
        if ((await $`cd ./dist/aur-${pkg} && git diff --cached --quiet`.nothrow()).exitCode === 0) break
        await $`cd ./dist/aur-${pkg} && git commit -m "Update to v${Script.version}"`
        await $`cd ./dist/aur-${pkg} && git push`
        break
      } catch {
        continue
      }
    }
  }

  // Homebrew formula
  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was generated by GoReleaser. DO NOT EDIT.",
    "class MongolGPT < Formula",
    `  desc "Mongolian-first AI coding agent built for the terminal."`,
    `  homepage "https://github.com/sergei10a-rgb/mongolgpt"`,
    `  version "${Script.version.split("-")[0]}"`,
    "",
    `  depends_on "ripgrep"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/sergei10a-rgb/mongolgpt/releases/download/${releaseTag}/mongolgpt-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "mongolgpt"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/sergei10a-rgb/mongolgpt/releases/download/${releaseTag}/mongolgpt-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "mongolgpt"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/sergei10a-rgb/mongolgpt/releases/download/${releaseTag}/mongolgpt-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    '        bin.install "mongolgpt"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/sergei10a-rgb/mongolgpt/releases/download/${releaseTag}/mongolgpt-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    '        bin.install "mongolgpt"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.error("GITHUB_TOKEN is required to update homebrew tap")
    process.exit(1)
  }
  const tap = `https://x-access-token:${token}@github.com/sergei10a-rgb/homebrew-tap.git`
  await $`rm -rf ./dist/homebrew-tap`
  await $`git clone ${tap} ./dist/homebrew-tap`
  await Bun.file("./dist/homebrew-tap/mongolgpt.rb").write(homebrewFormula)
  await $`cd ./dist/homebrew-tap && git add mongolgpt.rb`
  if ((await $`cd ./dist/homebrew-tap && git diff --cached --quiet`.nothrow()).exitCode !== 0) {
    await $`cd ./dist/homebrew-tap && git commit -m "Update to v${Script.version}"`
    await $`cd ./dist/homebrew-tap && git push`
  }
}
