#!/usr/bin/env bun

import { Script } from "@mongolgpt/script"
import { $ } from "bun"
import { rm } from "node:fs/promises"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const dryRun = process.argv.includes("--dry-run")
const skipBuild = process.argv.includes("--skip-build")

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

const originalText = await Bun.file("package.json").text()
const pkg = JSON.parse(originalText) as {
  name: string
  version: string
  exports: Record<string, unknown>
}
const version = Script.version
const tarball = `${pkg.name.replace("@", "").replace("/", "-")}-${version}.tgz`
function transformExports(exports: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      if (typeof value === "string") {
        const file = value.replace("./src/", "./dist/").replace(".ts", "")
        return [key, { import: file + ".js", types: file + ".d.ts" }]
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return [key, transformExports(value)]
      }
      return [key, value]
    }),
  )
}
if (!dryRun && (await published(pkg.name, version))) {
  console.log(`already published ${pkg.name}@${version}`)
} else {
  if (!skipBuild) await $`bun run build`
  pkg.version = version
  pkg.exports = transformExports(pkg.exports)
  await Bun.write("package.json", JSON.stringify(pkg, null, 2))
  try {
    await rm(tarball, { force: true })
    await $`bun pm pack`
    await $`bun ./script/smoke-packed.ts --tarball ${tarball}`
    await $`npm publish ${tarball} --tag ${Script.channel} --access public ${dryRun ? "--dry-run" : []}`
    if (dryRun) console.log(`[dry-run] ${pkg.name}@${version} package publish бэлэн байна`)
  } finally {
    await Bun.write("package.json", originalText)
    await rm(tarball, { force: true })
  }
}
