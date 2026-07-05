import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { defaultAuthUrl, defaultConsoleUrl, normalizeServerUrl, resolveAuthServerUrl } from "../../src/account/url"

describe("account url helpers", () => {
  const previousAuthUrl = process.env.MONGOLGPT_AUTH_URL

  beforeEach(() => {
    delete process.env.MONGOLGPT_AUTH_URL
  })

  afterEach(() => {
    if (previousAuthUrl === undefined) delete process.env.MONGOLGPT_AUTH_URL
    else process.env.MONGOLGPT_AUTH_URL = previousAuthUrl
  })

  test("defaults to the MongolGPT console origin", () => {
    expect(defaultConsoleUrl).toBe("https://mongolgpt.duckdns.org")
  })

  test("normalizes console UI paths back to the account API origin", () => {
    expect(normalizeServerUrl("https://mongolgpt.duckdns.org/console")).toBe("https://mongolgpt.duckdns.org")
    expect(normalizeServerUrl("https://mongolgpt.duckdns.org/auth?next=/workspace")).toBe(
      "https://mongolgpt.duckdns.org",
    )
  })

  test("keeps custom API path prefixes", () => {
    expect(normalizeServerUrl("https://example.com/mongolgpt-api/")).toBe("https://example.com/mongolgpt-api")
  })

  test("resolves the production auth issuer from the console origin", () => {
    expect(resolveAuthServerUrl(defaultConsoleUrl)).toBe(defaultAuthUrl)
  })

  test("keeps explicit auth issuer URLs", () => {
    expect(resolveAuthServerUrl("https://example.com/auth/dev")).toBe("https://example.com/auth/dev")
    expect(resolveAuthServerUrl("https://auth.example.com")).toBe("https://auth.example.com")
  })
})
