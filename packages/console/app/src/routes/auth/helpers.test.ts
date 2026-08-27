import { describe, expect, test } from "bun:test"
import {
  authCallbackTarget,
  canonicalHttpsOrigin,
  configuredAppUrl,
  configuredConsoleRequestUrl,
  currentAuthAccount,
  safeAuthContinue,
} from "./helpers"

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
        new URL("https://dev.mgpt.mn/auth/callback/auth/app?source=login&code=secret-code&state=oauth-state"),
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

describe("configuredConsoleRequestUrl", () => {
  test("accepts only the exact configured hosted console origin", () => {
    expect(
      configuredConsoleRequestUrl(
        "https://dev.mgpt.mn/auth/authorize?continue=%2Fauth%2Fapp",
        "https://dev.mgpt.mn",
      )?.pathname,
    ).toBe("/auth/authorize")
    expect(
      configuredConsoleRequestUrl("https://alias.dev.mgpt.mn/auth/authorize", "https://dev.mgpt.mn"),
    ).toBeUndefined()
    expect(
      configuredConsoleRequestUrl("https://dev.mgpt.mn/auth/callback?code=one", "https://dev.mgpt.mn/path"),
    ).toBeUndefined()
    expect(
      configuredConsoleRequestUrl("https://dev.mgpt.mn/auth/callback?code=one", "https://dev.mgpt.mn/#fragment"),
    ).toBeUndefined()
  })

  test("fails closed without hosted configuration but keeps loopback development", () => {
    expect(configuredConsoleRequestUrl("https://dev.mgpt.mn/auth/callback", undefined)).toBeUndefined()
    expect(configuredConsoleRequestUrl("http://127.0.0.1:3000/auth/callback", "not-a-url")).toBeUndefined()
    expect(configuredConsoleRequestUrl("http://127.0.0.1:3000/auth/callback", undefined)?.origin).toBe(
      "http://127.0.0.1:3000",
    )
  })
})

describe("canonicalHttpsOrigin", () => {
  test("canonicalizes a clean HTTPS origin", () => {
    expect(canonicalHttpsOrigin(" https://app.dev.mgpt.mn/ ")).toBe("https://app.dev.mgpt.mn")
  })

  test("rejects non-origin URLs and non-HTTPS URLs", () => {
    expect(canonicalHttpsOrigin("https://app.dev.mgpt.mn/path")).toBeUndefined()
    expect(canonicalHttpsOrigin("http://localhost:3000/")).toBeUndefined()
    expect(canonicalHttpsOrigin("https://user:pass@app.dev.mgpt.mn/")).toBeUndefined()
  })
})

describe("currentAuthAccount", () => {
  test("selects only the current account", () => {
    const account = { id: "acct_current", email: "current@example.com", authVersion: 4 }
    expect(
      currentAuthAccount({
        data: {
          current: "acct_current",
          account: { acct_other: { id: "acct_other", email: "other@example.com" }, acct_current: account },
        },
      }),
    ).toEqual(account)
  })

  test("returns no account when current is missing or stale", () => {
    expect(currentAuthAccount({ data: { account: { acct: { id: "acct", email: "a@example.com" } } } })).toBeUndefined()
    expect(
      currentAuthAccount({ data: { current: "missing", account: { acct: { id: "acct", email: "a@example.com" } } } }),
    ).toBeUndefined()
  })

  test("rejects malformed current account credentials", () => {
    expect(
      currentAuthAccount({
        data: { current: "acct", account: { acct: { id: "other", email: "a@example.com" } } },
      }),
    ).toBeUndefined()
    expect(
      currentAuthAccount({
        data: { current: "acct", account: { acct: { id: "acct", email: " a@example.com" } } },
      }),
    ).toBeUndefined()
    expect(
      currentAuthAccount({
        data: { current: "acct", account: { acct: { id: "acct", email: "a@example.com", authVersion: -1 } } },
      }),
    ).toBeUndefined()
  })
})
