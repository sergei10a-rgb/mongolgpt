import { describe, expect, test } from "bun:test"
import { modelSecretName, readModelSecretParts, serializeModelSecretEnv } from "../script/model-secret"

describe("gateway model secret migration", () => {
  test("prefers the canonical secret set", () => {
    const values = readModelSecretParts(
      [`${modelSecretName(0)}={\"models\":`, `${modelSecretName(1)}={}}`, 'ZEN_MODELS1={"legacy":true}'].join("\n"),
    )

    expect(values.slice(0, 2)).toEqual(['{"models":', "{}}"])
  })

  test("falls back to the legacy set while the stage is migrated", () => {
    const values = readModelSecretParts(['ZEN_MODELS1={"models":', "ZEN_MODELS2={}}"].join("\n"))
    expect(values.slice(0, 2)).toEqual(['{"models":', "{}}"])
  })

  test("writes only canonical names", () => {
    const output = serializeModelSecretEnv(['{"models":{}}', ""])
    expect(output).toContain('MONGOLGPT_GATEWAY_MODELS1="{\\"models\\":{}}"')
    expect(output).toContain('MONGOLGPT_GATEWAY_MODELS2=""')
    expect(output).not.toContain("ZEN_MODELS")
  })
})
