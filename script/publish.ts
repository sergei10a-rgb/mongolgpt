#!/usr/bin/env bun

import { Script } from "@mongolgpt/script"
import { $ } from "bun"
import { fileURLToPath } from "url"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSha256Sums, RELEASE_ARTIFACTS, RELEASE_CHECKSUM_ASSET } from "../packages/script/src/release-integrity"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const tag = `mongolgpt-v${Script.version}`

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

async function prepareReleaseFiles() {
  for (const file of pkgjsons) {
    let pkg = await Bun.file(file).text()
    pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
    console.log("updated:", file)
    await Bun.file(file).write(pkg)
  }

  await $`bun install`
  await $`./packages/sdk/js/script/build.ts`
}

async function publishReleaseChecksums() {
  const repo = process.env.GH_REPO
  if (!repo) throw new Error("GH_REPO is required to publish release checksums")
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mongolgpt-release-"))
  try {
    await $`gh release download ${tag} --repo ${repo} --dir ${temp}`
    const files = await Promise.all(
      RELEASE_ARTIFACTS.map(async (name) => ({ name, bytes: await Bun.file(path.join(temp, name)).bytes() })),
    )
    const checksumPath = path.join(temp, RELEASE_CHECKSUM_ASSET)
    await Bun.write(checksumPath, createSha256Sums(files))
    await $`gh release upload ${tag} ${checksumPath} --clobber --repo ${repo}`
    await $`bun ./packages/mongolgpt/script/release-preflight.ts --github`
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
}

if (Script.release && !Script.preview) {
  await $`git fetch origin --tags`
  await $`git switch --detach`
}

await prepareReleaseFiles()

console.log("\n=== cli ===\n")
await $`bun ./packages/mongolgpt/script/publish.ts`

console.log("\n=== preview cli ===\n")
await $`bun ./packages/cli/script/publish.ts`

console.log("\n=== sdk ===\n")
await $`bun ./packages/sdk/js/script/publish.ts`

console.log("\n=== plugin ===\n")
await $`bun ./packages/plugin/script/publish.ts`

console.log("\n=== ui ===\n")
await $`bun ./packages/ui/script/publish.ts`
await $`bun ./packages/mongolgpt/script/release-preflight.ts --npm`

if (Script.release) {
  await $`bun ./packages/desktop/scripts/finalize-latest-json.ts`
  await $`bun ./packages/desktop/scripts/finalize-latest-yml.ts`
  await publishReleaseChecksums()
}

if (Script.release && !Script.preview) {
  await $`git commit -am "release: ${tag}"`
  await $`git tag -d ${tag}`.nothrow()
  await $`git tag ${tag}`
  await $`git push origin refs/tags/${tag} --force-with-lease --no-verify`
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  await $`git fetch origin`
  await $`git checkout -B dev origin/dev`
  await prepareReleaseFiles()
  await $`git commit -am "sync release versions for ${tag}"`
  await $`git push origin HEAD:dev --no-verify`
}

if (Script.release) {
  await $`gh release edit ${tag} --draft=false --repo ${process.env.GH_REPO}`
}
