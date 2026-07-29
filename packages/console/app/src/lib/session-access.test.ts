import { describe, expect, test } from "bun:test"
import { resolveSessionAccess } from "./session-access"

const accountID = "acc_01K2A3B4C5D6E7F8G9H0J1K2M3"
const credential = {
  id: accountID,
  email: "user@mgpt.mn",
  authVersion: 2,
}
const active = {
  id: accountID,
  status: "active" as const,
  auth_version: 2,
  timeDeleted: null,
}

describe("web session account access", () => {
  test("keeps an active credential with the current auth version", () => {
    expect(
      resolveSessionAccess({
        accounts: { [accountID]: credential },
        current: accountID,
        records: [active],
      }),
    ).toEqual({
      accounts: { [accountID]: credential },
      current: accountID,
      blocked: undefined,
      suspended: false,
    })
  })

  test("removes and marks a suspended account", () => {
    expect(
      resolveSessionAccess({
        accounts: { [accountID]: credential },
        current: accountID,
        records: [{ ...active, status: "suspended" }],
      }),
    ).toEqual({
      accounts: {},
      current: undefined,
      blocked: "suspended",
      suspended: true,
    })
  })

  test("revokes a stale credential without mislabeling it as suspended", () => {
    expect(
      resolveSessionAccess({
        accounts: { [accountID]: { ...credential, authVersion: 1 } },
        current: accountID,
        records: [active],
      }),
    ).toEqual({
      accounts: {},
      current: undefined,
      blocked: undefined,
      suspended: false,
    })
  })

  test("preserves a prior suspended marker until a fresh login", () => {
    expect(
      resolveSessionAccess({
        accounts: {},
        blocked: "suspended",
        records: [],
      }),
    ).toEqual({
      accounts: {},
      current: undefined,
      blocked: "suspended",
      suspended: true,
    })
  })
})
