import { describe, expect, test } from "bun:test"
import { createHostedAccountPlatform } from "./hosted-account-platform"

const runtimeUrl = "https://runtime.dev.mgpt.mn"
const publicOrigin = "https://dev.mgpt.mn"
const workspace = { id: "wrk_12345", name: "Миний workspace" }

describe("hosted account platform", () => {
  const overview = {
    account: {
      id: "acc_12345",
      email: "user@example.com",
      status: "active" as const,
      createdAt: 1_700_000_000_000,
    },
    currentWorkspaceID: "wrk_12345",
    workspaces: [
      {
        id: "wrk_12345",
        name: "Миний workspace",
        slug: "my-workspace",
        userID: "usr_12345",
        role: "admin" as const,
        subscription: null,
        limits: {
          plan: "free" as const,
          promoTokens: 0,
          dailyRequests: 10,
          dailyRequestsFallback: 10,
        },
        quota: {
          status: "model-scoped" as const,
          reason: "free-auto-model-limits" as const,
        },
        usage: {
          scope: "workspace" as const,
          period: "week" as const,
          periodStart: 1_700_000_000_000,
          periodEnd: 1_700_086_400_000,
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costInMicroCents: 0,
        },
      },
    ],
  }

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
        workspace,
        expiresAt: Date.now() + 60_000,
      }),
    })

    expect(await api?.current()).toEqual({
      id: "account_123",
      email: "user@example.com",
      url: publicOrigin,
      activeOrgID: workspace.id,
    })
  })

  test("validates a workspace switch with the server before persisting it", async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }
    const selected: Array<string | undefined> = []
    const api = createHostedAccountPlatform({
      mode: "hosted",
      runtimeUrl,
      publicOrigin,
      storage,
      loadSession: async (_runtime, _public, workspaceID) => {
        selected.push(workspaceID)
        return {
          authenticated: true,
          account: { id: "account_123", email: "user@example.com" },
          workspace: { id: workspaceID ?? workspace.id, name: "Шинэ workspace" },
          expiresAt: Date.now() + 60_000,
        }
      },
    })

    await expect(api?.switchWorkspace?.("  wrk_new  ")).resolves.toMatchObject({ activeOrgID: "wrk_new" })
    expect(selected).toEqual(["wrk_new"])
    await expect(api?.current()).resolves.toMatchObject({ activeOrgID: "wrk_new" })
    expect(selected).toEqual(["wrk_new", "wrk_new"])
  })

  test("recovers from a revoked stored workspace and rejects a mismatched switch", async () => {
    const values = new Map([[`mongolgpt.hosted.workspace.v1:${publicOrigin}`, "wrk_revoked"]])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }
    const selected: Array<string | undefined> = []
    const api = createHostedAccountPlatform({
      mode: "hosted",
      runtimeUrl,
      publicOrigin,
      storage,
      loadSession: async (_runtime, _public, workspaceID) => {
        selected.push(workspaceID)
        if (workspaceID === "wrk_revoked") {
          return {
            authenticated: true,
            account: { id: "account_123", email: "user@example.com" },
            workspaceRequired: true,
            forbidden: true,
            workspaces: [workspace],
          }
        }
        return {
          authenticated: true,
          account: { id: "account_123", email: "user@example.com" },
          workspace,
          expiresAt: Date.now() + 60_000,
        }
      },
    })

    await expect(api?.current()).resolves.toMatchObject({ activeOrgID: workspace.id })
    expect(selected).toEqual(["wrk_revoked", undefined])
    expect([...values.values()]).toEqual([workspace.id])

    await expect(api?.switchWorkspace?.("wrk_different")).rejects.toThrow("шилжиж чадсангүй")
    expect([...values.values()]).toEqual([workspace.id])
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

  test("fetches and validates the shared account overview contract", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const api = createHostedAccountPlatform({
      mode: "hosted",
      runtimeUrl,
      publicOrigin,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify(overview), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        })
      },
    })

    await expect(api?.overview("  wrk_12345  ")).resolves.toEqual(overview)
    expect(requests).toEqual([
      {
        url: "https://dev.mgpt.mn/v1/account/overview",
        init: {
          credentials: "include",
          headers: { Accept: "application/json", "X-Org-ID": "wrk_12345" },
        },
      },
    ])
  })

  test("fails closed for non-JSON, non-2xx, and malformed success responses", async () => {
    const responses = [
      new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
      new Response(JSON.stringify(overview), { status: 401, headers: { "content-type": "application/json" } }),
      new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ ...overview, account: { ...overview.account, id: "not-an-account" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]

    for (const response of responses) {
      const api = createHostedAccountPlatform({
        mode: "hosted",
        runtimeUrl,
        publicOrigin,
        fetch: async () => response,
      })
      await expect(api?.overview()).rejects.toMatchObject({
        message: "Бүртгэлийн төлөвийг авах боломжгүй байна",
      })
    }
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
