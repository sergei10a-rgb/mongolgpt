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
  exports: Record<string, string>
  dependencies?: Record<string, string>
}
const version = Script.version
const tarball = `${pkg.name.replace("@", "").replace("/", "-")}-${version}.tgz`

if (!dryRun && (await published(pkg.name, version))) {
  console.log(`already published ${pkg.name}@${version}`)
} else {
  if (!skipBuild) await $`bun run build`
  pkg.version = version
  for (const [key, value] of Object.entries(pkg.exports)) {
    const file = value.replace("./src/", "./dist/").replace(".ts", "")
    // @ts-ignore
    pkg.exports[key] = {
      import: file + ".js",
      types: file + ".d.ts",
    }
  }
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies ?? {}).map(([name, value]) => [
      name,
      value.startsWith("workspace:") ? version : value,
    ]),
  )
  await Bun.write("package.json", JSON.stringify(pkg, null, 2))
  try {
    await rm(tarball, { force: true })
    await $`bun pm pack`
    await $`npm publish ${tarball} --tag ${Script.channel} --access public ${dryRun ? "--dry-run" : []}`
    if (dryRun) console.log(`[dry-run] ${pkg.name}@${version} package publish бэлэн байна`)
  } finally {
    await Bun.write("package.json", originalText)
    await rm(tarball, { force: true })
  }
}
