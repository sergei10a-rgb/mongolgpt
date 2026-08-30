import { describe, expect, mock, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { createServerRequest } from "@/utils/server"
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

  test("uses the connected bridge as the active server for a follow-up runtime request", async () => {
    const observed: Array<{ path: string; authorization: string | null }> = []
    using runtime = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        observed.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
        })
        return Response.json({ healthy: true })
      },
    })

    const bridge = {
      ...connection,
      url: `http://127.0.0.1:${runtime.port}`,
    }
    let active: ServerConnection.Http | undefined
    const addEphemeral = mock((input: ServerConnection.Http) => {
      active = { ...input, ephemeral: true }
      return active
    })

    await connectLocalBridgeCallback({
      currentURL: "https://app.dev.mgpt.mn/#bridge=callback",
      exchange: mock(async () => bridge),
      currentAccountID: mock(async () => bridge.accountID),
      addEphemeral,
      name: "MongolGPT ширээний апп",
      accountMismatch: "Ширээний болон веб аппын аккаунт таарахгүй байна.",
      expired: "Ширээний аппын холболтын хугацаа дууссан байна.",
    })

    expect(active?.ephemeral).toBe(true)
    const response = await createServerRequest({ server: active!.http, fetch: Bun.fetch })("/global/health")
    expect(response.status).toBe(200)
    expect(observed).toEqual([
      {
        path: "/global/health",
        authorization: `Basic ${btoa(`${bridge.username}:${bridge.password}`)}`,
      },
    ])
  })
})
