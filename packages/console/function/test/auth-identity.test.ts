import { describe, expect, test } from "bun:test"
import { OAuthIdentityConflictError, resolveOAuthAccountIdentity } from "../src/auth-identity"

describe("OAuth account identity resolution", () => {
  test.each([
    [{}, undefined],
    [{ providerAccountID: "account-provider" }, "account-provider"],
    [{ emailAccountID: "account-email" }, "account-email"],
    [{ providerAccountID: "account-same", emailAccountID: "account-same" }, "account-same"],
  ])("resolves %j to %s", (input, expected) => {
    expect(resolveOAuthAccountIdentity(input)).toEqual(expected)
  })

  test("fails closed before any identity write can proceed", () => {
    let writes = 0

    expect(() => {
      const resolution = resolveOAuthAccountIdentity({
        providerAccountID: "account-provider",
        emailAccountID: "account-email",
      })
      writes += 1
      return resolution
    }).toThrow(OAuthIdentityConflictError)

    expect(writes).toBe(0)
  })
})
