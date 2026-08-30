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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function output(result: ReturnType<typeof spawnSync>) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
}

const tarballOption = option("--tarball")
assert(tarballOption, "@mongolgpt/ui smoke-д --tarball <file> шаардлагатай")
const tarball = path.resolve(tarballOption)
assert(fs.existsSync(tarball) && fs.statSync(tarball).isFile(), `@mongolgpt/ui tarball олдсонгүй: ${tarball}`)

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mongolgpt-ui-smoke-"))
const npm = process.platform === "win32" ? "npm.cmd" : "npm"

try {
  const npmrc = path.join(root, "public.npmrc")
  await fs.promises.writeFile(npmrc, "registry=https://registry.npmjs.org/\nalways-auth=false\n")
  const publicEnv = { ...process.env }
  for (const key of Object.keys(publicEnv)) {
    const normalized = key.toLowerCase()
    if (normalized === "node_auth_token" || normalized === "npm_token" || normalized.includes("_authtoken")) {
      delete publicEnv[key]
    }
  }
  publicEnv.NPM_CONFIG_USERCONFIG = npmrc
  publicEnv.NPM_CONFIG_CACHE = path.join(root, ".npm-cache")
  publicEnv.NPM_CONFIG_REGISTRY = "https://registry.npmjs.org/"

  await fs.promises.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies: { "@mongolgpt/ui": pathToFileURL(tarball).href } }, null, 2)}\n`,
  )
  await fs.promises.writeFile(
    path.join(root, "entry.tsx"),
    [
      'import { Button } from "@mongolgpt/ui/button"',
      'import "@mongolgpt/ui/styles"',
      'if (typeof Button !== "function") throw new Error("Button export missing")',
      'document.body.dataset.component = Button.name || "Button"',
      "",
    ].join("\n"),
  )

  const install = spawnSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: root,
    env: publicEnv,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  })
  assert(install.status === 0, `@mongolgpt/ui consumer install failed: ${output(install)}`)

  const build = spawnSync(
    process.execPath,
    ["build", "entry.tsx", "--outdir", "dist", "--target", "browser", "--production"],
    { cwd: root, env: publicEnv, encoding: "utf8", timeout: 120_000, windowsHide: true },
  )
  assert(build.status === 0, `@mongolgpt/ui consumer build failed: ${output(build)}`)

  const outputs = Array.from(new Bun.Glob("**/*").scanSync({ cwd: path.join(root, "dist"), onlyFiles: true }))
  assert(outputs.some((name) => name.endsWith(".js")), "@mongolgpt/ui consumer JavaScript bundle үүссэнгүй")
  assert(outputs.some((name) => name.endsWith(".css")), "@mongolgpt/ui consumer stylesheet bundle үүссэнгүй")
  console.log("@mongolgpt/ui packed consumer smoke ok")
} finally {
  await fs.promises.rm(root, { recursive: true, force: true })
}
