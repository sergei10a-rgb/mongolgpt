import { describe, expect, test } from "bun:test"
import { parseSmokeAuthCookie } from "./network"

const origin = "https://dev.mgpt.mn"
const token = "authenticated-smoke-token-value"

describe("deployed browser auth cookie", () => {
  test("creates one host-only secure cookie without exposing the token in metadata", () => {
    expect(parseSmokeAuthCookie(`__Host-mongolgpt-auth=${token}`, origin)).toEqual({
      name: "__Host-mongolgpt-auth",
      value: token,
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    })
  })

  test("rejects cookie headers, attributes, weak tokens, and non-HTTPS origins", () => {
    for (const value of [
      `Cookie: __Host-mongolgpt-auth=${token}`,
      `__Host-mongolgpt-auth=${token}; Path=/`,
      `__Host-mongolgpt-auth=${token} `,
      "__Host-mongolgpt-auth=short",
      `other=${token}`,
    ]) {
      expect(() => parseSmokeAuthCookie(value, origin)).toThrow()
    }
    expect(() => parseSmokeAuthCookie(`__Host-mongolgpt-auth=${token}`, "http://dev.mgpt.mn")).toThrow()
  })

  test("never includes the secret token in validation errors", () => {
    const secret = `${token};Path=/`
    try {
      parseSmokeAuthCookie(`__Host-mongolgpt-auth=${secret}`, origin)
      throw new Error("expected cookie validation to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret)
    }
  })
})
