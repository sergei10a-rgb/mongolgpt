import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import {
  defaultAuthUrl,
  defaultConsoleUrl,
  isBlockedAccountAddress,
  normalizeServerUrl,
  resolveAccountVerificationUrl,
  resolveAuthServerUrl,
  validateAccountOAuthMetadata,
  validateAccountServerUrl,
  validateConfiguredAccountServerUrl,
} from "../../src/account/url"

describe("account url helpers", () => {
  const previousAuthUrl = process.env.MONGOLGPT_AUTH_URL

  beforeEach(() => {
    delete process.env.MONGOLGPT_AUTH_URL
  })

  afterEach(() => {
    if (previousAuthUrl === undefined) delete process.env.MONGOLGPT_AUTH_URL
    else process.env.MONGOLGPT_AUTH_URL = previousAuthUrl
  })

  test("defaults to the local MongolGPT console origin", () => {
    expect(defaultConsoleUrl).toBe("http://localhost:3000")
  })

  test("normalizes console UI paths back to the account API origin", () => {
    expect(normalizeServerUrl("https://console.example.com/console")).toBe("https://console.example.com")
    expect(normalizeServerUrl("https://console.example.com/auth?next=/workspace")).toBe("https://console.example.com")
  })

  test("keeps custom API path prefixes", () => {
    expect(normalizeServerUrl("https://example.com/mongolgpt-api/")).toBe("https://example.com/mongolgpt-api")
    expect(normalizeServerUrl("https://example.com/go")).toBe("https://example.com/go")
    expect(normalizeServerUrl("https://example.com/zen")).toBe("https://example.com/zen")
  })

  test("resolves the production auth issuer from the console origin", () => {
    expect(resolveAuthServerUrl(defaultConsoleUrl)).toBe(defaultAuthUrl)
  })

  test("resolves hosted console URLs even when the source CLI defaults to localhost", () => {
    expect(resolveAuthServerUrl("https://mgpt.mn")).toBe("https://auth.mgpt.mn")
    expect(resolveAuthServerUrl("https://dev.mgpt.mn")).toBe("https://auth.dev.mgpt.mn")
  })

  test("keeps hosted auth discovery when only the console URL is overridden", () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      MONGOLGPT_CONSOLE_URL: "https://dev.mgpt.mn",
    }
    delete env.MONGOLGPT_AUTH_URL
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'const mod = await import("./src/account/url.ts"); console.log(mod.resolveAuthServerUrl(mod.defaultConsoleUrl))',
      ],
      { cwd: fileURLToPath(new URL("../..", import.meta.url)), env },
    )
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString().trim()).toBe("https://auth.dev.mgpt.mn")
  })

  test("keeps explicit auth issuer URLs", () => {
    expect(resolveAuthServerUrl("https://example.com/auth/dev")).toBe("https://example.com/auth/dev")
    expect(resolveAuthServerUrl("https://auth.example.com")).toBe("https://auth.example.com")
  })

  test("allows HTTPS and local development account servers only", () => {
    expect(validateAccountServerUrl("https://accounts.example.com/console")).toBe("https://accounts.example.com")
    expect(validateAccountServerUrl("http://127.0.0.1:3000/console")).toBe("http://127.0.0.1:3000")
    expect(() => validateAccountServerUrl("http://accounts.example.com")).toThrow("HTTPS")
    expect(() => validateAccountServerUrl("https://user:secret@accounts.example.com")).toThrow("нэвтрэх мэдээлэл")
    expect(() => validateAccountServerUrl("https://10.0.0.1")).toThrow("private")
  })

  test("resolves device verification URLs without leaving the account origin", () => {
    expect(resolveAccountVerificationUrl("https://accounts.example.com/api", "/device?user_code=ABCD")).toBe(
      "https://accounts.example.com/device?user_code=ABCD",
    )
    expect(resolveAccountVerificationUrl("https://accounts.example.com/api", "verify?user_code=ABCD")).toBe(
      "https://accounts.example.com/api/verify?user_code=ABCD",
    )
    expect(
      resolveAccountVerificationUrl(
        "https://accounts.example.com",
        "https://accounts.example.com/device?user_code=ABCD",
      ),
    ).toBe("https://accounts.example.com/device?user_code=ABCD")
    expect(() => resolveAccountVerificationUrl("https://accounts.example.com", "https://evil.example/device")).toThrow(
      "ижил origin",
    )
    expect(() => resolveAccountVerificationUrl("https://accounts.example.com", " ")).toThrow("хоосон")
  })

  test("trusts only configured MongolGPT account origins by default", () => {
    expect(validateConfiguredAccountServerUrl("https://mgpt.mn/console")).toBe("https://mgpt.mn")
    expect(validateConfiguredAccountServerUrl("https://dev.mgpt.mn/console")).toBe("https://dev.mgpt.mn")
    expect(validateConfiguredAccountServerUrl("http://localhost:3000/custom-prefix")).toBe(
      "http://localhost:3000/custom-prefix",
    )
    expect(() => validateConfiguredAccountServerUrl("https://accounts.example.com")).toThrow("албан ёсны")
  })

  test("rejects private and reserved DNS results", () => {
    expect(isBlockedAccountAddress("127.0.0.1")).toBe(true)
    expect(isBlockedAccountAddress("169.254.169.254")).toBe(true)
    expect(isBlockedAccountAddress("10.20.30.40")).toBe(true)
    expect(isBlockedAccountAddress("1.1.1.1")).toBe(false)
    expect(isBlockedAccountAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isBlockedAccountAddress("::ffff:10.0.0.1")).toBe(true)
    expect(isBlockedAccountAddress("::ffff:8.8.8.8")).toBe(false)
  })

  test("requires OAuth metadata endpoints to use the issuer origin", () => {
    expect(() =>
      validateAccountOAuthMetadata("https://auth.example.com", {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
      }),
    ).not.toThrow()
    expect(() =>
      validateAccountOAuthMetadata("https://auth.example.com", {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://evil.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
      }),
    ).toThrow("ижил origin")
  })
})
