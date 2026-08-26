#!/usr/bin/env bun

import { $ } from "bun"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  RELEASE_ARTIFACTS,
  RELEASE_CHECKSUM_ASSET,
  createSha256Sums,
  validateReleaseChecksumContract,
} from "@mongolgpt/script/release-integrity"

const dist = path.resolve(import.meta.dirname, "../dist")
const repo = process.env.GH_REPO ?? "sergei10a-rgb/mongolgpt"
const checkNpm = process.argv.includes("--npm")
const checkGitHub = process.argv.includes("--github")

const binaryPackages = [
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
] as const

const cliPackages = [...binaryPackages, "mongolgpt"]
const npmPackages = [...cliPackages, "@mongolgpt/sdk", "@mongolgpt/plugin", "@mongolgpt/ui"]

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string }
}

function binaryName(name: string) {
  return name.includes("-windows-") || name === "mongolgpt" ? "mongolgpt.exe" : "mongolgpt"
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function checkLocalDist() {
  assert(fs.existsSync(dist), `dist directory missing: ${dist}`)
  const versions = new Set<string>()

  for (const name of cliPackages) {
    const dir = path.join(dist, name)
    const pkgFile = path.join(dir, "package.json")
    assert(fs.existsSync(pkgFile), `missing ${pkgFile}`)

    const pkg = readJson(pkgFile)
    assert(pkg.name === name, `${pkgFile} has name ${pkg.name}, expected ${name}`)
    assert(pkg.version, `${pkgFile} is missing version`)
    versions.add(pkg.version!)

    const bin = path.join(dir, "bin", binaryName(name))
    assert(fs.existsSync(bin), `missing ${bin}`)
    const size = fs.statSync(bin).size
    if (name !== "mongolgpt") assert(size > 1_000_000, `binary too small: ${bin}`)
  }

  assert(versions.size === 1, `package versions differ: ${Array.from(versions).join(", ")}`)
  return Array.from(versions)[0]!
}

async function npmMissing(version: string) {
  const missing: string[] = []
  for (const name of npmPackages) {
    const result = await $`npm view ${name}@${version} version --silent`.quiet().nothrow()
    if (result.exitCode !== 0) missing.push(name)
  }
  return missing
}

async function githubMissing(version: string) {
  const tag = `mongolgpt-v${version}`
  const result = await $`gh release view ${tag} --repo ${repo} --json assets`.quiet().nothrow()
  if (result.exitCode !== 0) return [`release:${tag}`]

  const data = JSON.parse(result.stdout.toString()) as { assets?: { name?: string }[] }
  const assetNames = new Set(
    (data.assets ?? []).map((asset) => asset.name).filter((name): name is string => Boolean(name)),
  )
  const missing = validateReleaseChecksumContract(Array.from(assetNames))
  if (!missing.includes(`missing ${RELEASE_CHECKSUM_ASSET}`)) {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mongolgpt-release-preflight-"))
    try {
      const checksum = await $`gh release download ${tag} --repo ${repo} --dir ${temp}`.quiet().nothrow()
      if (checksum.exitCode !== 0) missing.push(`unable to download ${RELEASE_CHECKSUM_ASSET}`)
      else {
        const content = fs.readFileSync(path.join(temp, RELEASE_CHECKSUM_ASSET), "utf8")
        missing.push(
          ...validateReleaseChecksumContract(Array.from(assetNames), content).filter((item) => !missing.includes(item)),
        )
        const files = await Promise.all(
          RELEASE_ARTIFACTS.map(async (name) => ({ name, bytes: await Bun.file(path.join(temp, name)).bytes() })),
        )
        const expected = createSha256Sums(files)
        if (content !== expected) missing.push("checksum content does not match release artifacts")
      }
    } finally {
      await fs.promises.rm(temp, { recursive: true, force: true })
    }
  }
  return missing
}

const version = checkLocalDist()
console.log(`local dist ok: ${cliPackages.length} packages @ ${version}`)

if (checkNpm) {
  const missing = await npmMissing(version)
  console.log(missing.length ? `npm missing: ${missing.join(", ")}` : "npm ok")
  if (missing.length) process.exitCode = 1
}

if (checkGitHub) {
  const missing = await githubMissing(version)
  console.log(missing.length ? `github release missing: ${missing.join(", ")}` : "github release ok")
  if (missing.length) process.exitCode = 1
}
