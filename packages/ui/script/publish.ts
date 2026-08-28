#!/usr/bin/env bun

import { Script } from "@mongolgpt/script"
import { $ } from "bun"
import { rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { pack } from "./pack"

process.chdir(fileURLToPath(new URL("..", import.meta.url)))
const dryRun = process.argv.includes("--dry-run")
const skipBuild = process.argv.includes("--skip-build")

const pkg = (await Bun.file("package.json").json()) as { name: string; version: string }
const version = Script.version
const tarball = `${pkg.name.replace("@", "").replace("/", "-")}-${version}.tgz`

if (!dryRun && (await $`npm view ${pkg.name}@${version} version`.nothrow()).exitCode === 0) {
  console.log(`already published ${pkg.name}@${version}`)
  process.exit(0)
}

try {
  if (!skipBuild) {
    await $`bun run typecheck`
    await $`bun run test`
  }
  await pack({ version, skipBuild })
  await $`npm publish ${tarball} --access public --tag ${Script.channel} ${dryRun ? "--dry-run" : []}`
  if (dryRun) console.log(`[dry-run] ${pkg.name}@${version} package publish бэлэн байна`)
} finally {
  await rm(tarball, { force: true })
}
