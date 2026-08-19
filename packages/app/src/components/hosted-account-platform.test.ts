import { describe, expect, test } from "bun:test"
import { createHostedAccountPlatform } from "./hosted-account-platform"

const runtimeUrl = "https://runtime.dev.mgpt.mn"
const publicOrigin = "https://dev.mgpt.mn"

describe("hosted account platform", () => {
  test("is available only for a configured hosted runtime", () => {
    expect(createHostedAccountPlatform({ mode: "local-bridge", runtimeUrl, publicOrigin })).toBeUndefined()
    expect(createHostedAccountPlatform({ mode: "hosted", publicOrigin })).toBeUndefined()
    expect(createHostedAccountPlatform({ mode: "hosted", runtimeUrl })).toBeUndefined()
    expect(
      createHostedAccountPlatform({ mode: "hosted", runtimeUrl: "file:///tmp/runtime", publicOrigin }),
    ).toBeUndefined()
    expect(
      createHostedAccountPlatform({ mode: "hosted", runtimeUrl, publicOrigin: "javascript:alert(1)" }),
    ).toBeUndefined()
    expect(
      createHostedAccountPlatform({ mode: "hosted", runtimeUrl: "http://runtime.dev.mgpt.mn", publicOrigin }),
    ).toBeUndefined()
  })

  test("maps the authenticated hosted session to the shared account contract", async () => {
    const api = createHostedAccountPlatform({
      mode: "hosted",
      runtimeUrl,
      publicOrigin: `${publicOrigin}/`,
      loadSession: async () => ({
        authenticated: true,
        account: { id: "account_123", email: "user@example.com" },
        expiresAt: Date.now() + 60_000,
      }),
    })

    expect(await api?.current()).toEqual({
      id: "account_123",
      email: "user@example.com",
      url: publicOrigin,
    })
  })

  test("keeps an unauthenticated hosted session signed out", async () => {
    const api = createHostedAccountPlatform({
      mode: "hosted",
      runtimeUrl,
      publicOrigin,
      loadSession: async () => ({ authenticated: false }),
    })

    expect(await api?.current()).toBeNull()
  })

  test("uses same-origin login and logout routes", async () => {
    const urls: string[] = []
    const api = createHostedAccountPlatform({
      mode: "hosted",
      runtimeUrl,
      publicOrigin,
      navigate: (url) => {
        urls.push(url)
        throw new Error("navigation")
      },
    })

    await expect(api?.login()).rejects.toThrow("navigation")
    await expect(api?.logout()).rejects.toThrow("navigation")
    expect(urls).toEqual([
      "https://dev.mgpt.mn/auth/authorize?continue=%2Fauth%2Fapp",
      "https://dev.mgpt.mn/auth/logout",
    ])
  })
})
