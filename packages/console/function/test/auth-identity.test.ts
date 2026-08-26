import { describe, expect, test } from "bun:test"
import {
  OAuthIdentityConflictError,
  resolveActiveOAuthAccountIdentity,
  resolveOAuthAccountIdentity,
} from "../src/auth-identity"

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

  test("ignores soft-deleted identities during account resolution", () => {
    expect(
      resolveActiveOAuthAccountIdentity(
        [
          { provider: "github", accountID: "account-deleted", timeDeleted: 1 },
          { provider: "email", accountID: "account-active", timeDeleted: null },
        ],
        "github",
      ),
    ).toBe("account-active")

    expect(
      resolveActiveOAuthAccountIdentity(
        [
          { provider: "github", accountID: "account-deleted-provider", timeDeleted: 1 },
          { provider: "email", accountID: "account-deleted-email", timeDeleted: 2 },
        ],
        "github",
      ),
    ).toBeUndefined()
  })

  test("still fails closed when active provider and email identities conflict", () => {
    expect(() =>
      resolveActiveOAuthAccountIdentity(
        [
          { provider: "github", accountID: "account-provider", timeDeleted: null },
          { provider: "email", accountID: "account-email", timeDeleted: null },
          { provider: "email", accountID: "account-deleted", timeDeleted: 1 },
        ],
        "github",
      ),
    ).toThrow(OAuthIdentityConflictError)
  })
})
