#!/usr/bin/env bun

import fs from "node:fs/promises"
import {
  MODEL_SECRET_PARTS,
  gatewaySstEnvironmentLines,
  prepareDevFreeAuto,
} from "@mongolgpt/script/dev-free-auto"

const githubEnvironment = process.env.GITHUB_ENV
if (!githubEnvironment) fail("GITHUB_ENV тохируулаагүй байна.")

try {
  const result = prepareDevFreeAuto({
    legacyParts: Array.from(
      { length: MODEL_SECRET_PARTS },
      (_, index) => process.env[`MONGOLGPT_GATEWAY_MODELS${index + 1}`] ?? "",
    ),
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    nvidiaNimApiKey: process.env.NVIDIA_NIM_API_KEY,
    nvidiaNimModel: process.env.NVIDIA_NIM_MODEL_ID,
  })
  await fs.appendFile(githubEnvironment, `${gatewaySstEnvironmentLines(result.parts).join("\n")}\n`, "utf8")
  if (result.source === "disabled") {
    console.log("Dev Free Auto provider key-гүй тул model catalog идэвхгүй хэвээр үлдлээ.")
  } else if (result.source === "legacy") {
    console.log("Dev Free Auto хуучин multipart catalog-ийг баталгаажуулж ашиглана.")
  } else {
    console.log("Dev Free Auto OpenRouter болон NVIDIA NIM secret-ээс catalog үүсгэлээ.")
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

function fail(message: string): never {
  console.error(`Dev Free Auto catalog бэлдэхэд алдаа гарлаа: ${message}`)
  process.exit(1)
}
