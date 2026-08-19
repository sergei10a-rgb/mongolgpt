import { describe, expect, test } from "bun:test"

import { createPinnedAccountFetch, resolveAccountTransport } from "../../src/account/transport"

describe("account transport", () => {
  test("connects to the validated IP without resolving the request hostname again", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return Response.json({ host: request.headers.get("host"), path: new URL(request.url).pathname })
      },
    })
    try {
      const origin = `http://account.invalid:${server.port}`
      const response = await createPinnedAccountFetch(origin, { address: "127.0.0.1", family: 4 })(
        `${origin}/api/user`,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ host: `account.invalid:${server.port}`, path: "/api/user" })
    } finally {
      server.stop(true)
    }
  })

  test("refuses requests that leave the validated origin", async () => {
    const request = createPinnedAccountFetch("https://accounts.example.com", {
      address: "93.184.216.34",
      family: 4,
    })
    await expect(request("https://evil.example/api/user")).rejects.toThrow("origin")
  })

  test("rejects mixed public and private DNS answers before creating a transport", async () => {
    await expect(
      resolveAccountTransport("https://accounts.example.com", {
        allowCustomAccountServer: true,
        resolveDns: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow("private")
  })
})
