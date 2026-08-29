#!/usr/bin/env bun

import { $ } from "bun"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  RELEASE_CHECKSUM_ASSET,
  createSha256Sums,
  isChecksummedReleaseAsset,
  releaseUpdaterMetadataAssets,
  resolveReleaseUpdaterChannel,
  validateReleaseChecksumContract,
  validateUpdaterReleaseContract,
} from "@mongolgpt/script/release-integrity"

const dist = path.resolve(import.meta.dirname, "../dist")
const repo = process.env.GH_REPO ?? "sergei10a-rgb/mongolgpt"
const checkNpm = process.argv.includes("--npm")
const checkNpmCli = process.argv.includes("--npm-cli")
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
const legacyBrand = /\bOpenCode\b|opencode\.ai|anomalyco|@opencode\/|github\.com\/(?:sst|anomalyco)\/opencode/i

type PackageManifest = {
  name?: string
  version?: string
  description?: string
  repository?: { type?: string; url?: string; directory?: string }
  homepage?: string
  bugs?: { url?: string }
  license?: string
  files?: string[]
}

function objectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return Reflect.get(value, key)
}

function readJson(file: string) {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  const text = (key: string) => {
    const value = objectProperty(parsed, key)
    return typeof value === "string" ? value : undefined
  }
  const repository = objectProperty(parsed, "repository")
  const bugs = objectProperty(parsed, "bugs")
  const rawFiles = objectProperty(parsed, "files")
  return {
    name: text("name"),
    version: text("version"),
    description: text("description"),
    repository: {
      type:
        typeof objectProperty(repository, "type") === "string" ? String(objectProperty(repository, "type")) : undefined,
      url:
        typeof objectProperty(repository, "url") === "string" ? String(objectProperty(repository, "url")) : undefined,
      directory:
        typeof objectProperty(repository, "directory") === "string"
          ? String(objectProperty(repository, "directory"))
          : undefined,
    },
    homepage: text("homepage"),
    bugs: { url: typeof objectProperty(bugs, "url") === "string" ? String(objectProperty(bugs, "url")) : undefined },
    license: text("license"),
    files: Array.isArray(rawFiles) ? rawFiles.filter((value): value is string => typeof value === "string") : undefined,
  } satisfies PackageManifest
}

function binaryName(name: string) {
  return name.includes("-windows-") || name === "mongolgpt" ? "mongolgpt.exe" : "mongolgpt"
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function assertNoLegacyBrand(label: string, value: string) {
  const match = legacyBrand.exec(value)
  assert(!match, `${label} contains legacy product branding: ${match?.[0]}`)
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
    assertNoLegacyBrand(pkgFile, fs.readFileSync(pkgFile, "utf8"))
    versions.add(pkg.version!)

    const bin = path.join(dir, "bin", binaryName(name))
    assert(fs.existsSync(bin), `missing ${bin}`)
    const size = fs.statSync(bin).size
    if (name !== "mongolgpt") assert(size > 1_000_000, `binary too small: ${bin}`)
  }

  assert(versions.size === 1, `package versions differ: ${Array.from(versions).join(", ")}`)

  const main = readJson(path.join(dist, "mongolgpt", "package.json"))
  assert(main.description?.includes("Монгол хэрэглэгчдэд"), "mongolgpt package is missing Mongolian description")
  assert(
    main.repository?.url === "git+https://github.com/sergei10a-rgb/mongolgpt.git" &&
      main.repository.directory === "packages/mongolgpt",
    "mongolgpt package has incorrect repository metadata",
  )
  assert(main.homepage === "https://mgpt.mn/", "mongolgpt package has incorrect homepage")
  assert(
    main.bugs?.url === "https://github.com/sergei10a-rgb/mongolgpt/issues",
    "mongolgpt package has incorrect issue tracker",
  )
  assert(main.license === "MIT", "mongolgpt package has incorrect license")
  assert(main.files?.includes("README.md"), "mongolgpt package does not publish README.md")
  const readme = path.join(dist, "mongolgpt", "README.md")
  assert(fs.existsSync(readme), "mongolgpt package README.md is missing")
  assertNoLegacyBrand(readme, fs.readFileSync(readme, "utf8"))
  return Array.from(versions)[0]
}

async function npmMissing(version: string, packages: readonly string[]) {
  const missing: string[] = []
  for (const name of packages) {
    const result = await $`npm view ${name}@${version} version --silent`.quiet().nothrow()
    if (result.exitCode !== 0) missing.push(name)
  }
  return missing
}

function commandOutput(result: ReturnType<typeof spawnSync>) {
  const stdout = typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "")
  const stderr = typeof result.stderr === "string" ? result.stderr : (result.stderr?.toString() ?? "")
  return (stdout + stderr).trim()
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
    assertNoLegacyBrand("public npm account help", commandOutput(accountHelp))

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

    const optionalProvider = spawnSync(
      binary,
      ["run", "--model", "ollama/account-gate-smoke", "--format", "json", "npm release smoke"],
      { cwd: repo, env: publicEnv, encoding: "utf8", timeout: 30_000 },
    )
    assert(optionalProvider.status !== null, "public npm optional provider account gate timed out")
    assert(optionalProvider.status !== 0, "anonymous public npm optional provider request unexpectedly succeeded")
    assert(
      commandOutput(optionalProvider).includes("mongolgpt account login"),
      `public npm optional provider account gate returned the wrong guidance: ${commandOutput(optionalProvider)}`,
    )

    for (const args of [
      [
        "run",
        "--attach",
        "http://127.0.0.1:1",
        "--model",
        "ollama/account-gate-smoke",
        "--format",
        "json",
        "npm release smoke",
      ],
      ["attach", "http://127.0.0.1:1"],
    ]) {
      const attached = spawnSync(binary, args, { cwd: repo, env: publicEnv, encoding: "utf8", timeout: 30_000 })
      assert(attached.status !== null, `public npm attach account gate timed out: ${args.join(" ")}`)
      assert(attached.status !== 0, `anonymous public npm attach unexpectedly succeeded: ${args.join(" ")}`)
      assert(
        /холбогдсон сервер дээр.*бүртгэлээр нэвтэрч/.test(commandOutput(attached)),
        `public npm attach account gate returned the wrong guidance: ${commandOutput(attached)}`,
      )
    }

    console.log(
      `public npm install smoke ok: mongolgpt@${version}, version, Git repo, Free Auto, optional provider, and attach account gates`,
    )
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
}

async function smokePublicPlatformPackages(version: string) {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mongolgpt-platform-npm-smoke-"))
  const npmrc = path.join(temp, "public.npmrc")
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"

  try {
    await fs.promises.writeFile(path.join(temp, "package.json"), '{"private":true,"type":"module"}\n')
    await fs.promises.writeFile(npmrc, `registry=${publicNpmRegistry}\n`)
    const publicEnv = { ...process.env }
    for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete publicEnv[key]
    Object.assign(publicEnv, {
      NPM_CONFIG_USERCONFIG: npmrc,
      NPM_CONFIG_CACHE: path.join(temp, "npm-cache"),
    })

    const packages = ["@mongolgpt/sdk", "@mongolgpt/plugin", "@mongolgpt/ui"] as const
    const install = spawnSync(
      npm,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        ...packages.map((name) => `${name}@${version}`),
      ],
      { cwd: temp, env: publicEnv, encoding: "utf8", timeout: 120_000 },
    )
    assert(install.status === 0, `public platform package install failed: ${commandOutput(install)}`)

    for (const name of packages) {
      const manifestPath = path.join(temp, "node_modules", ...name.split("/"), "package.json")
      const manifest = readJson(manifestPath)
      assert(manifest.name === name, `public package manifest has name ${manifest.name}, expected ${name}`)
      assert(manifest.version === version, `public ${name} resolved ${manifest.version}, expected ${version}`)
      assertNoLegacyBrand(manifestPath, fs.readFileSync(manifestPath, "utf8"))
    }

    const imports = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        'await import("@mongolgpt/sdk"); await import("@mongolgpt/plugin"); console.log("platform imports ok")',
      ],
      { cwd: temp, env: publicEnv, encoding: "utf8", timeout: 30_000 },
    )
    assert(
      imports.status === 0 && commandOutput(imports).includes("platform imports ok"),
      `public SDK/plugin import smoke failed: ${commandOutput(imports)}`,
    )

    const uiRoot = path.join(temp, "node_modules", "@mongolgpt", "ui")
    for (const file of ["README.md", "LICENSE", "src/styles/index.css", "dist/hooks/index.d.ts"]) {
      assert(fs.existsSync(path.join(uiRoot, file)), `public @mongolgpt/ui is missing ${file}`)
    }
    console.log(`public npm platform smoke ok: ${packages.join(", ")} @ ${version}`)
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
}

async function githubMissing(version: string) {
  const tag = `mongolgpt-v${version}`
  const result = await $`gh release view ${tag} --repo ${repo} --json assets,body,tagName`.quiet().nothrow()
  if (result.exitCode !== 0) return [`release:${tag}`]

  const parsed: unknown = JSON.parse(result.stdout.toString())
  const rawAssets = objectProperty(parsed, "assets")
  const assetNames = new Set(
    (Array.isArray(rawAssets) ? rawAssets : [])
      .map((asset) => objectProperty(asset, "name"))
      .filter((name): name is string => typeof name === "string" && Boolean(name)),
  )
  const rawBody = objectProperty(parsed, "body")
  const body = typeof rawBody === "string" || rawBody === null ? rawBody : undefined
  const rawTagName = objectProperty(parsed, "tagName")
  const tagName = typeof rawTagName === "string" ? rawTagName : undefined
  const missing = validateReleaseChecksumContract(Array.from(assetNames))
  if (tagName !== tag) missing.push(`release tag mismatch: expected ${tag}, got ${tagName ?? "missing"}`)
  const channel = resolveReleaseUpdaterChannel(process.env.MONGOLGPT_CHANNEL, version)
  const updater = releaseUpdaterMetadataAssets(channel)
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mongolgpt-release-preflight-"))
  try {
    const download = await $`gh release download ${tag} --repo ${repo} --dir ${temp}`.quiet().nothrow()
    if (download.exitCode !== 0) {
      missing.push("unable to download release assets")
      return missing
    }

    const read = async (name: string) => {
      const file = Bun.file(path.join(temp, name))
      return (await file.exists()) ? file.text() : undefined
    }
    const content = await read(RELEASE_CHECKSUM_ASSET)
    if (content) {
      missing.push(
        ...validateReleaseChecksumContract(Array.from(assetNames), content).filter((item) => !missing.includes(item)),
      )
      const files = await Promise.all(
        Array.from(assetNames)
          .filter(isChecksummedReleaseAsset)
          .map(async (name) => ({ name, bytes: await Bun.file(path.join(temp, name)).bytes() })),
      )
      const expected = createSha256Sums(files)
      if (content !== expected) missing.push("checksum content does not match release artifacts")
    }

    const latestJson = await read(updater.json)
    const metadata = {
      windows: await read(updater.windows),
      linuxX64: await read(updater.linuxX64),
      linuxArm64: await read(updater.linuxArm64),
      mac: await read(updater.mac),
    }
    missing.push(
      ...validateUpdaterReleaseContract({
        version,
        repo,
        channel,
        assetNames: Array.from(assetNames),
        releaseBody: body,
        latestJson,
        metadata,
      }).filter((item) => !missing.includes(item)),
    )
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
  return missing
}

const version = checkLocalDist()
console.log(`local dist ok: ${cliPackages.length} packages @ ${version}`)

const checkedNpmPackages = checkNpm ? npmPackages : checkNpmCli ? cliPackages : undefined

if (checkedNpmPackages) {
  const missing = await npmMissing(version, checkedNpmPackages)
  console.log(missing.length ? `npm missing: ${missing.join(", ")}` : "npm ok")
  if (missing.length) process.exitCode = 1
  else {
    await smokePublicNpmInstall(version)
    if (checkNpm) await smokePublicPlatformPackages(version)
  }
}

if (checkGitHub) {
  const missing = await githubMissing(version)
  console.log(missing.length ? `github release missing: ${missing.join(", ")}` : "github release ok")
  if (missing.length) process.exitCode = 1
}
