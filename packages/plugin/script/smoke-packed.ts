#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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

const pluginTarballOption = option("--plugin-tarball")
assert(pluginTarballOption, "@mongolgpt/plugin smoke-д --plugin-tarball <file> шаардлагатай")
const pluginTarball = path.resolve(pluginTarballOption)
assert(
  fs.existsSync(pluginTarball) && fs.statSync(pluginTarball).isFile(),
  `@mongolgpt/plugin tarball олдсонгүй: ${pluginTarball}`,
)

const sdkTarballOption = option("--sdk-tarball")
assert(sdkTarballOption, "@mongolgpt/plugin smoke-д --sdk-tarball <file> шаардлагатай")
const sdkTarball = path.resolve(sdkTarballOption)
assert(fs.existsSync(sdkTarball) && fs.statSync(sdkTarball).isFile(), `@mongolgpt/sdk tarball олдсонгүй: ${sdkTarball}`)

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mongolgpt-plugin-smoke-"))
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const node = process.platform === "win32" ? "node.exe" : "node"

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
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@mongolgpt/sdk": sdkTarball,
          "@mongolgpt/plugin": pluginTarball,
        },
      },
      null,
      2,
    )}\n`,
  )
  await fs.promises.writeFile(
    path.join(root, "entry.mjs"),
    [
      'import { createMongolGPTClient } from "@mongolgpt/sdk"',
      'import { tool as rootTool } from "@mongolgpt/plugin"',
      'import { tool } from "@mongolgpt/plugin/tool"',
      'import { define as defineEffectPlugin } from "@mongolgpt/plugin/v2/effect"',
      'import { define as definePromisePlugin } from "@mongolgpt/plugin/v2/promise"',
      'const client = createMongolGPTClient({ baseUrl: "http://localhost:4096" })',
      'if (typeof client !== "object" || client === null) throw new Error("sdk export missing")',
      'const definition = tool({ description: "smoke", args: {}, async execute() { return "ok" } })',
      'if (typeof definition.execute !== "function") throw new Error("plugin tool export missing")',
      'if (rootTool !== tool) throw new Error("plugin root export missing")',
      'const effectPlugin = defineEffectPlugin({ id: "effect-smoke", effect() {} })',
      'const promisePlugin = definePromisePlugin({ id: "promise-smoke", setup() {} })',
      'if (effectPlugin.id !== "effect-smoke") throw new Error("effect plugin export missing")',
      'if (promisePlugin.id !== "promise-smoke") throw new Error("promise plugin export missing")',
      'console.log("plugin-packed-consumer-smoke-ok")',
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
  assert(install.status === 0, `@mongolgpt/plugin consumer install failed: ${output(install)}`)

  const run = spawnSync(node, ["entry.mjs"], {
    cwd: root,
    env: publicEnv,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  })
  assert(run.status === 0, `@mongolgpt/plugin consumer runtime failed: ${output(run)}`)
  console.log("@mongolgpt/plugin packed consumer smoke ok")
} finally {
  await fs.promises.rm(root, { recursive: true, force: true })
}
