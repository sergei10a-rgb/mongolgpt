#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import os from "os"
import { GatewayCatalog } from "../src/model"
import { readModelSecretParts, serializeModelSecretEnv } from "./model-secret"

const stage = process.argv[2]
if (!stage) throw new Error("Stage is required")

const root = path.resolve(process.cwd(), "..", "..", "..")

// read the secret
const ret = await $`bun sst secret list --stage frank`.cwd(root).text()
const values = readModelSecretParts(ret)

// validate value
GatewayCatalog.validate(JSON.parse(values.join("")))

// update the secret
const envFile = Bun.file(path.join(os.tmpdir(), `models-${Date.now()}.env`))
await envFile.write(serializeModelSecretEnv(values))
await $`bun sst secret load ${envFile.name} --stage ${stage}`.cwd(root)
