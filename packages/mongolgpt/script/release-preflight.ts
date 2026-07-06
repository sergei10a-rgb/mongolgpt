#!/usr/bin/env bun

import { $ } from "bun"
import fs from "node:fs"
import path from "node:path"

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

const packages = [...binaryPackages, "mongolgpt"]

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

  for (const name of packages) {
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
  for (const name of packages) {
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
  const assetNames = new Set((data.assets ?? []).map((asset) => asset.name).filter(Boolean))
  const expected = [
    ...binaryPackages.map((name) => `${name}${name.includes("linux") ? ".tar.gz" : ".zip"}`),
    "mongolgpt-desktop-win-x64.exe",
  ]
  return expected.filter((name) => !assetNames.has(name))
}

const version = checkLocalDist()
console.log(`local dist ok: ${packages.length} packages @ ${version}`)

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
