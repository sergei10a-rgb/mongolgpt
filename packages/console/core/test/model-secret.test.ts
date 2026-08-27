import { describe, expect, test } from "bun:test"
import { modelSecretName, readModelSecretParts, serializeModelSecretEnv } from "../script/model-secret"

describe("gateway model secrets", () => {
  test("reads the canonical secret set", () => {
    const values = readModelSecretParts([`${modelSecretName(0)}={\"models\":`, `${modelSecretName(1)}={}}`].join("\n"))

    expect(values.slice(0, 2)).toEqual(['{"models":', "{}}"])
  })

  test("rejects retired secret names", () => {
    expect(() => readModelSecretParts(['ZEN_MODELS1={"models":', "ZEN_MODELS2={}}"].join("\n"))).toThrow(
      "MONGOLGPT_GATEWAY_MODELS1",
    )
  })

  test("writes only canonical names", () => {
    const output = serializeModelSecretEnv(['{"models":{}}', ""])
    expect(output).toContain('MONGOLGPT_GATEWAY_MODELS1="{\\"models\\":{}}"')
    expect(output).toContain('MONGOLGPT_GATEWAY_MODELS2=""')
    expect(output).not.toContain("ZEN_MODELS")
  })
})
