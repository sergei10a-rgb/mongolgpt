#!/usr/bin/env bun

import { Script } from "@mongolgpt/script"
import { $ } from "bun"
import { createReleaseNotes, releaseTag } from "../packages/script/src/release-integrity"
import { resolveProductServiceUrls } from "../packages/core/src/product"

const output = [
  `version=${Script.version}`,
  `channel=${Script.channel}`,
  `account_url=${resolveProductServiceUrls(Script.channel).console}`,
]
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
const tag = releaseTag(Script.version)
const repo = process.env.GH_REPO

if ((!Script.preview || Script.channel === "beta") && repo !== "sergei10a-rgb/mongolgpt") {
  throw new Error("Release GH_REPO must be sergei10a-rgb/mongolgpt")
}

async function createNotesFile() {
  await $`bun script/changelog.ts --to ${sha}`.cwd(process.cwd())
  const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`
  const changelog = await Bun.file(file)
    .text()
    .catch(() => "")
  const body = createReleaseNotes(Script.version, changelog)
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const notesFile = `${dir}/mongolgpt-release-notes.txt`
  await Bun.write(notesFile, body)
  return notesFile
}

if (!Script.preview) {
  const notesFile = await createNotesFile()
  await $`gh release create ${tag} -d --target ${sha} --title "MongolGPT v${Script.version}" --notes-file ${notesFile} --repo ${repo}`
  const release = await $`gh release view ${tag} --json tagName,databaseId --repo ${repo}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
} else if (Script.channel === "beta") {
  const notesFile = await createNotesFile()
  await $`gh release create ${tag} -d --target ${sha} --title "MongolGPT v${Script.version}" --notes-file ${notesFile} --repo ${repo}`
  const release = await $`gh release view ${tag} --json tagName,databaseId --repo ${repo}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
