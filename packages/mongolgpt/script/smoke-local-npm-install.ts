#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const dist = path.resolve(option("--dist") ?? path.resolve(import.meta.dirname, "../dist"))
const expectedAccountUrl = option("--expected-account-url")
const npm = process.platform === "win32" ? "npm.cmd" : "npm"

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
const packageNames = [...binaryPackages, "mongolgpt"] as const

type Manifest = {
  name?: string
  version?: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function output(result: ReturnType<typeof spawnSync>) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
}

function readManifest(directory: string) {
  return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as Manifest
}

function run(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) {
  return spawnSync(executable, args, {
    ...options,
    encoding: "utf8",
    windowsHide: true,
  })
}

function pack(directory: string, destination: string, env: NodeJS.ProcessEnv) {
  const result = run(npm, ["pack", "--json", "--pack-destination", destination], {
    cwd: directory,
    env,
    timeout: 120_000,
  })
  assert(result.status === 0, `npm pack failed for ${directory}: ${output(result)}`)

  const data = JSON.parse(String(result.stdout)) as { filename?: string }[]
  const filename = data[0]?.filename
  assert(filename, `npm pack did not return a tarball for ${directory}`)
  return path.join(destination, filename)
}

assert(expectedAccountUrl, "--expected-account-url is required")
assert(fs.existsSync(dist), `dist directory missing: ${dist}`)

const version = readManifest(path.join(dist, "mongolgpt")).version
assert(version, "dist/mongolgpt/package.json is missing version")

for (const name of packageNames) {
  const directory = path.join(dist, name)
  assert(fs.existsSync(directory), `package directory missing: ${directory}`)
  const manifest = readManifest(directory)
  assert(manifest.name === name, `${name} package name is ${manifest.name}`)
  assert(manifest.version === version, `${name} version is ${manifest.version}, expected ${version}`)
}

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mongolgpt-local-npm-smoke-"))
const tarballs = path.join(root, "tarballs")
const install = path.join(root, "install")
const repo = path.join(root, "repo")
const npmrc = path.join(root, "public.npmrc")

try {
  await fs.promises.mkdir(tarballs, { recursive: true })
  await fs.promises.mkdir(install, { recursive: true })
  await fs.promises.mkdir(repo, { recursive: true })
  await fs.promises.writeFile(npmrc, "registry=https://registry.npmjs.org\n")

  const isolatedEnv = { ...process.env }
  for (const key of [
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "NPM_CONFIG_IGNORE_SCRIPTS",
    "MONGOLGPT_CONSOLE_TOKEN",
    "MONGOLGPT_API_KEY",
  ]) {
    delete isolatedEnv[key]
  }
  Object.assign(isolatedEnv, {
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    MONGOLGPT_TEST_HOME: root,
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(root, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_DATA_HOME: path.join(root, ".local", "share"),
    XDG_STATE_HOME: path.join(root, ".local", "state"),
    XDG_CACHE_HOME: path.join(root, ".cache"),
    MONGOLGPT_CONFIG_CONTENT: '{"formatter":false,"lsp":false}',
    MONGOLGPT_AUTH_CONTENT: "{}",
    MONGOLGPT_DISABLE_PROJECT_CONFIG: "1",
    MONGOLGPT_DISABLE_AUTOUPDATE: "1",
    MONGOLGPT_DISABLE_AUTOCOMPACT: "1",
    MONGOLGPT_DISABLE_MODELS_FETCH: "1",
    MONGOLGPT_PURE: "1",
  })

  const dependencies: Record<string, string> = {}
  for (const name of packageNames) {
    const tarball = pack(path.join(dist, name), tarballs, isolatedEnv)
    dependencies[name] = pathToFileURL(tarball).href
  }
  await fs.promises.writeFile(
    path.join(install, "package.json"),
    `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
  )

  const npmInstall = run(npm, ["install", "--force", "--offline", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: install,
    env: isolatedEnv,
    timeout: 300_000,
  })
  assert(npmInstall.status === 0, `local npm install failed: ${output(npmInstall)}`)

  for (const name of packageNames) {
    const manifest = readManifest(path.join(install, "node_modules", name))
    assert(manifest.name === name, `installed package name is ${manifest.name}, expected ${name}`)
    assert(manifest.version === version, `installed ${name} version is ${manifest.version}, expected ${version}`)
  }

  const shim = path.join(install, "node_modules", ".bin", process.platform === "win32" ? "mongolgpt.cmd" : "mongolgpt")
  assert(fs.existsSync(shim), `npm bin shim missing: ${shim}`)

  const binary = path.join(install, "node_modules", "mongolgpt", "bin", "mongolgpt.exe")
  assert(fs.existsSync(binary), `postinstall binary missing: ${binary}`)
  assert(fs.statSync(binary).size > 1_000_000, `postinstall binary is too small: ${binary}`)

  const git = run("git", ["init", "--quiet"], { cwd: repo, env: isolatedEnv, timeout: 30_000 })
  assert(git.status === 0, `unable to initialize smoke Git repository: ${output(git)}`)

  const cli = (args: string[]) => run(binary, args, { cwd: repo, env: isolatedEnv, timeout: 30_000 })
  const actualVersion = cli(["--version"])
  assert(
    actualVersion.status === 0 && output(actualVersion) === version,
    `version smoke failed: ${output(actualVersion)}`,
  )

  const accountHelp = cli(["account", "--help"])
  assert(
    accountHelp.status === 0 && output(accountHelp).includes("MongolGPT бүртгэл"),
    `account help smoke failed: ${output(accountHelp)}`,
  )

  const accountLoginHelp = cli(["account", "login", "--help"])
  assert(
    accountLoginHelp.status === 0 && output(accountLoginHelp).includes(expectedAccountUrl),
    `account login URL smoke failed: ${output(accountLoginHelp)}`,
  )

  const freeAuto = cli(["run", "--model", "mongolgpt/free-auto", "--format", "json", "local npm smoke"])
  assert(freeAuto.status !== null, "anonymous Free Auto gate timed out")
  assert(freeAuto.status !== 0, "anonymous Free Auto request unexpectedly succeeded")
  assert(
    output(freeAuto).includes("mongolgpt account login"),
    `Free Auto gate returned wrong guidance: ${output(freeAuto)}`,
  )

  const optionalProvider = cli(["run", "--model", "ollama/account-gate-smoke", "--format", "json", "local npm smoke"])
  assert(optionalProvider.status !== null, "optional provider account gate timed out")
  assert(optionalProvider.status !== 0, "anonymous optional provider request unexpectedly succeeded")
  assert(
    output(optionalProvider).includes("mongolgpt account login"),
    `optional provider account gate returned wrong guidance: ${output(optionalProvider)}`,
  )

  console.log(
    `local npm install smoke ok: ${packageNames.length} packages @ ${version}, Free Auto and optional provider account gates`,
  )
} finally {
  await fs.promises.rm(root, { recursive: true, force: true })
}
