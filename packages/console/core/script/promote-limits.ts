#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { Subscription } from "../src/subscription"

const stage = process.argv[2]
if (!stage) throw new Error("Stage is required")

const root = path.resolve(process.cwd(), "..", "..", "..")

// read the secret
const ret = await $`bun sst secret list --fallback`.cwd(root).text()
const lines = ret.split("\n")
const value = lines
  .find((line) => line.startsWith("MONGOLGPT_PLAN_LIMITS="))
  ?.split("=")
  .slice(1)
  .join("=")
if (!value) throw new Error("MONGOLGPT_PLAN_LIMITS олдсонгүй")

// validate value
Subscription.validate(JSON.parse(value))

// update the secret
await $`bun sst secret set MONGOLGPT_PLAN_LIMITS ${value} --stage ${stage}`
