#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import os from "os"
import { Subscription } from "../src/subscription"

const root = path.resolve(process.cwd(), "..", "..", "..")
const secrets = await $`bun sst secret list --fallback`.cwd(root).text()

// read value
const lines = secrets.split("\n")
const oldValue = lines
  .find((line) => line.startsWith("MONGOLGPT_PLAN_LIMITS="))
  ?.split("=")
  .slice(1)
  .join("=")
if (!oldValue) throw new Error("MONGOLGPT_PLAN_LIMITS олдсонгүй")

// store the prettified json to a temp file
const filename = `limits-${Date.now()}.json`
const tempFile = Bun.file(path.join(os.tmpdir(), filename))
await tempFile.write(JSON.stringify(JSON.parse(oldValue), null, 2))
console.log("tempFile", tempFile.name)

// open temp file in vim and read the file on close
await $`vim ${tempFile.name}`
const newValue = JSON.stringify(JSON.parse(await tempFile.text()))
Subscription.validate(JSON.parse(newValue))

// update the secret
const envFile = Bun.file(path.join(os.tmpdir(), `limits-${Date.now()}.env`))
await envFile.write(`MONGOLGPT_PLAN_LIMITS="${newValue.replace(/"/g, '\\"')}"`)
await $`bun sst secret load ${envFile.name} --fallback`.cwd(root)
