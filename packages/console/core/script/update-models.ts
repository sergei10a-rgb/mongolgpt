#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import os from "os"
import { GatewayCatalog } from "../src/model"
import { MODEL_SECRET_PARTS, readModelSecretParts, serializeModelSecretEnv } from "./model-secret"

const root = path.resolve(process.cwd(), "..", "..", "..")
const models = await $`bun sst secret list --stage frank`.cwd(root).text()
const oldValues = readModelSecretParts(models)

// store the prettified json to a temp file
const filename = `models-${Date.now()}.json`
const tempFile = Bun.file(path.join(os.tmpdir(), filename))
await tempFile.write(JSON.stringify(JSON.parse(oldValues.join("")), null, 2))
console.log("tempFile", tempFile.name)

// open temp file in vim and read the file on close
await $`vim ${tempFile.name}`
const newValue = JSON.stringify(JSON.parse(await tempFile.text()))
GatewayCatalog.validate(JSON.parse(newValue))

// update the secret
const chunk = Math.ceil(newValue.length / MODEL_SECRET_PARTS)
const newValues = Array.from({ length: MODEL_SECRET_PARTS }, (_, i) =>
  newValue.slice(chunk * i, i === MODEL_SECRET_PARTS - 1 ? undefined : chunk * (i + 1)),
)

const envFile = Bun.file(path.join(os.tmpdir(), `models-${Date.now()}.env`))
await envFile.write(serializeModelSecretEnv(newValues))
await $`bun sst secret load ${envFile.name} --stage frank`.cwd(root)
