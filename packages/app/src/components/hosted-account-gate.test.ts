import { describe, expect, test } from "bun:test"
import { hostedAccountGateEnabled, hostedLoginUrl, hostedSessionUrl } from "./hosted-account-gate"

describe("hosted account gate helpers", () => {
  test("builds the runtime session endpoint", () => {
    expect(hostedSessionUrl("https://runtime.dev.mgpt.mn/")).toBe("https://runtime.dev.mgpt.mn/auth/session")
  })

  test("builds a fixed internal callback login URL", () => {
    expect(hostedLoginUrl("https://dev.mgpt.mn")).toBe(
      "https://dev.mgpt.mn/auth/authorize?continue=%2Fauth%2Fapp",
    )
  })

  test("only enables the gate for hosted runtimes", () => {
    expect(hostedAccountGateEnabled("hosted", "https://runtime.dev.mgpt.mn")).toBe(true)
    expect(hostedAccountGateEnabled("local-bridge", "https://runtime.dev.mgpt.mn")).toBe(false)
    expect(hostedAccountGateEnabled(undefined, "http://127.0.0.1:4096")).toBe(false)
  })
})
