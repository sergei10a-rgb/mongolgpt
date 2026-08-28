#!/usr/bin/env bun

import { $ } from "bun"
import { spawnSync } from "node:child_process"
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
const publicNpmRegistry = "https://registry.npmjs.org"

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

function commandOutput(result: ReturnType<typeof spawnSync>) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
}

async function smokePublicNpmInstall(version: string) {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mongolgpt-npm-smoke-"))
  const install = path.join(temp, "install")
  const repo = path.join(temp, "repo")
  const npmrc = path.join(temp, "public.npmrc")
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"

  try {
    await fs.promises.mkdir(install, { recursive: true })
    await fs.promises.mkdir(repo, { recursive: true })
    await fs.promises.writeFile(path.join(install, "package.json"), '{"private":true}\n')
    await fs.promises.writeFile(npmrc, `registry=${publicNpmRegistry}\n`)

    const publicEnv = { ...process.env }
    for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "MONGOLGPT_CONSOLE_TOKEN", "MONGOLGPT_API_KEY"]) {
      delete publicEnv[key]
    }
    Object.assign(publicEnv, {
      NPM_CONFIG_USERCONFIG: npmrc,
      NPM_CONFIG_CACHE: path.join(temp, "npm-cache"),
      MONGOLGPT_TEST_HOME: temp,
      HOME: temp,
      USERPROFILE: temp,
      APPDATA: path.join(temp, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(temp, "AppData", "Local"),
      XDG_CONFIG_HOME: path.join(temp, ".config"),
      XDG_DATA_HOME: path.join(temp, ".local", "share"),
      XDG_STATE_HOME: path.join(temp, ".local", "state"),
      XDG_CACHE_HOME: path.join(temp, ".cache"),
      MONGOLGPT_CONFIG_CONTENT: '{"formatter":false,"lsp":false}',
      MONGOLGPT_AUTH_CONTENT: "{}",
      MONGOLGPT_DISABLE_PROJECT_CONFIG: "1",
      MONGOLGPT_DISABLE_AUTOUPDATE: "1",
      MONGOLGPT_DISABLE_AUTOCOMPACT: "1",
      MONGOLGPT_DISABLE_MODELS_FETCH: "1",
      MONGOLGPT_PURE: "1",
    })

    let installResult: ReturnType<typeof spawnSync> | undefined
    for (let attempt = 1; attempt <= 5; attempt++) {
      installResult = spawnSync(
        npm,
        [
          "install",
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
          "--prefer-online",
          "--save-exact",
          `mongolgpt@${version}`,
        ],
        { cwd: install, env: publicEnv, encoding: "utf8", timeout: 120_000 },
      )
      if (installResult.status === 0) break
      if (attempt === 5) {
        throw new Error(`public npm install failed for mongolgpt@${version}: ${commandOutput(installResult)}`)
      }
      await fs.promises.rm(path.join(install, "node_modules"), { recursive: true, force: true })
      await fs.promises.rm(path.join(install, "package-lock.json"), { force: true })
      await new Promise((resolve) => setTimeout(resolve, attempt * 10_000))
    }

    const binary = path.join(install, "node_modules", "mongolgpt", "bin", "mongolgpt.exe")
    assert(fs.existsSync(binary), `public npm install is missing ${binary}`)

    const installed = readJson(path.join(install, "node_modules", "mongolgpt", "package.json"))
    assert(installed.version === version, `public npm install resolved ${installed.version}, expected ${version}`)

    const versionResult = spawnSync(binary, ["--version"], {
      cwd: repo,
      env: publicEnv,
      encoding: "utf8",
      timeout: 30_000,
    })
    assert(
      versionResult.status === 0 && commandOutput(versionResult) === version,
      `public npm CLI version smoke failed: ${commandOutput(versionResult)}`,
    )

    const accountHelp = spawnSync(binary, ["account", "--help"], {
      cwd: repo,
      env: publicEnv,
      encoding: "utf8",
      timeout: 30_000,
    })
    assert(
      accountHelp.status === 0 && commandOutput(accountHelp).includes("MongolGPT бүртгэл"),
      `public npm account command smoke failed: ${commandOutput(accountHelp)}`,
    )

    const git = spawnSync("git", ["init", "--quiet"], {
      cwd: repo,
      env: publicEnv,
      encoding: "utf8",
      timeout: 30_000,
    })
    assert(git.status === 0, `unable to initialize npm smoke Git repository: ${commandOutput(git)}`)

    const freeAuto = spawnSync(
      binary,
      ["run", "--model", "mongolgpt/free-auto", "--format", "json", "npm release smoke"],
      { cwd: repo, env: publicEnv, encoding: "utf8", timeout: 30_000 },
    )
    assert(freeAuto.status !== null, "public npm Free Auto account gate timed out")
    assert(freeAuto.status !== 0, "anonymous public npm Free Auto request unexpectedly succeeded")
    assert(
      commandOutput(freeAuto).includes("mongolgpt account login"),
      `public npm Free Auto account gate returned the wrong guidance: ${commandOutput(freeAuto)}`,
    )

    console.log(`public npm install smoke ok: mongolgpt@${version}, version, Git repo, Free Auto account gate`)
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
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
  else await smokePublicNpmInstall(version)
}

if (checkGitHub) {
  const missing = await githubMissing(version)
  console.log(missing.length ? `github release missing: ${missing.join(", ")}` : "github release ok")
  if (missing.length) process.exitCode = 1
}
