import { describe, expect, test } from "bun:test"
import { resolveAccountOverviewIdentity } from "./overview-auth"

const account = { accountID: "acc_auth_user", email: "user@mgpt.mn" }

function request(authorization?: string) {
  return new Request("https://dev.mgpt.mn/v1/account/overview", {
    headers: authorization ? { authorization } : undefined,
  })
}

describe("account overview authentication", () => {
  test("uses a verified bearer identity without loading a browser session", async () => {
    let sessions = 0
    const result = await resolveAccountOverviewIdentity(request("Bearer valid-token"), {
      verifyToken: async (token) => {
        expect(token).toBe("valid-token")
        return account
      },
      session: async () => {
        sessions++
        return { data: {}, suspended: false }
      },
    })
    expect(result).toEqual({ status: "authenticated", account: { id: account.accountID, email: account.email } })
    expect(sessions).toBe(0)
  })

  test("never falls back to a cookie session when an authorization header is malformed or invalid", async () => {
    for (const [header, valid] of [
      ["Basic secret", true],
      ["Bearer invalid", false],
    ] as const) {
      let sessions = 0
      const result = await resolveAccountOverviewIdentity(request(header), {
        verifyToken: async () => (valid ? account : undefined),
        session: async () => {
          sessions++
          return {
            data: {
              current: account.accountID,
              account: { [account.accountID]: { id: account.accountID, email: account.email } },
            },
            suspended: false,
          }
        },
      })
      expect(result).toEqual({ status: "unauthorized" })
      expect(sessions).toBe(0)
    }
  })

  test("resolves active, suspended, and anonymous browser sessions", async () => {
    expect(
      await resolveAccountOverviewIdentity(request(), {
        verifyToken: async () => undefined,
        session: async () => ({
          data: {
            current: account.accountID,
            account: { [account.accountID]: { id: account.accountID, email: account.email } },
          },
          suspended: false,
        }),
      }),
    ).toEqual({ status: "authenticated", account: { id: account.accountID, email: account.email } })
    expect(
      await resolveAccountOverviewIdentity(request(), {
        verifyToken: async () => undefined,
        session: async () => ({ data: {}, suspended: true }),
      }),
    ).toEqual({ status: "suspended" })
    expect(
      await resolveAccountOverviewIdentity(request(), {
        verifyToken: async () => undefined,
        session: async () => ({ data: {}, suspended: false }),
      }),
    ).toEqual({ status: "unauthorized" })
  })
})
