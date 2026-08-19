import { describe, expect, test } from "bun:test"
import { codeSample } from "../../src/cli/cmd/generate"

describe("CLI SDK code sample", () => {
  test("emits a complete MongolGPT SDK import", () => {
    const sample = codeSample("session.list")

    expect(sample.split("\n")[0]).toBe('import { createMongolGPTClient } from "@mongolgpt/sdk"')
    expect(sample).toContain("await client.session.list({")
  })
})
