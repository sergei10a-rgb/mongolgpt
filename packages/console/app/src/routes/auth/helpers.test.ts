import { describe, expect, test } from "bun:test"
import { authCallbackTarget, configuredAppUrl, safeAuthContinue } from "./helpers"

describe("safeAuthContinue", () => {
  test("keeps internal paths and query strings", () => {
    expect(safeAuthContinue("/auth/app?source=login")).toBe("/auth/app?source=login")
  })

  test("rejects external and protocol-relative targets", () => {
    expect(safeAuthContinue("https://example.com/steal")).toBe("")
    expect(safeAuthContinue("//example.com/steal")).toBe("")
  })
})

describe("authCallbackTarget", () => {
  test("preserves the internal continuation query and removes OAuth parameters", () => {
    expect(
      authCallbackTarget(
        new URL(
          "https://dev.mgpt.mn/auth/callback/auth/app?source=login&code=secret-code&state=oauth-state",
        ),
      ),
    ).toBe("/auth/app?source=login")
  })

  test("falls back to the account entrypoint", () => {
    expect(authCallbackTarget(new URL("https://dev.mgpt.mn/auth/callback?code=secret-code"))).toBe("/auth")
  })
})

describe("configuredAppUrl", () => {
  test("accepts an absolute configured app URL", () => {
    expect(configuredAppUrl("https://app.dev.mgpt.mn/")?.toString()).toBe("https://app.dev.mgpt.mn/")
  })

  test("rejects credentials and malformed URLs", () => {
    expect(configuredAppUrl("https://user:pass@app.dev.mgpt.mn")).toBeUndefined()
    expect(configuredAppUrl("http://app.dev.mgpt.mn")).toBeUndefined()
    expect(configuredAppUrl("not-a-url")).toBeUndefined()
  })

  test("allows plain HTTP only for local development", () => {
    expect(configuredAppUrl("http://127.0.0.1:3000")?.toString()).toBe("http://127.0.0.1:3000/")
  })
})
