import { describe, expect, mock, test } from "bun:test"
import { connectLocalBridgeCallback } from "./local-bridge-callback"

const connection = {
  url: "http://127.0.0.1:4321",
  username: "bridge" as const,
  password: "A".repeat(43),
  accountID: "account-1",
  expiresAt: Date.now() + 900_000,
}

function setup(accountID = connection.accountID) {
  const addEphemeral = mock(() => ({ type: "http" as const }))
  return {
    addEphemeral,
    input: {
      currentURL: "https://app.dev.mgpt.mn/#bridge=callback",
      exchange: mock(async () => connection),
      currentAccountID: mock(async () => accountID),
      addEphemeral,
      name: "MongolGPT ширээний апп",
      accountMismatch: "Ширээний болон веб аппын аккаунт таарахгүй байна.",
      expired: "Ширээний аппын холболтын хугацаа дууссан байна.",
    },
  }
}

describe("connectLocalBridgeCallback", () => {
  test("adds a memory-only server after the hosted account matches", async () => {
    const fixture = setup()
    await expect(connectLocalBridgeCallback(fixture.input)).resolves.toBe(connection)
    expect(fixture.addEphemeral).toHaveBeenCalledWith(
      {
        type: "http",
        displayName: "MongolGPT ширээний апп",
        http: {
          url: connection.url,
          username: connection.username,
          password: connection.password,
        },
      },
      connection.expiresAt,
    )
  })

  test("rejects a callback from another account before adding the server", async () => {
    const fixture = setup("different-account")
    await expect(connectLocalBridgeCallback(fixture.input)).rejects.toThrow("аккаунт таарахгүй байна")
    expect(fixture.addEphemeral).not.toHaveBeenCalled()
  })
})
