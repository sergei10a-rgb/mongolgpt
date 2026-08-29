import { describe, expect, test } from "bun:test"
import {
  AccountOverviewNotFoundError,
  AccountOverviewSuspendedError,
  AccountOverviewUnavailableError,
  AccountOverviewWorkspaceAccessError,
} from "@mongolgpt/console-core/account-overview.js"
import { accountOverviewPreflight, accountOverviewRequest, type AccountOverviewIdentity } from "./overview-handler"

const appUrl = "https://app.dev.mgpt.mn"
const account = { id: "acc_handler_user", email: "user@mgpt.mn" }
const overview = {
  account: { ...account, status: "active" as const, createdAt: 1_700_000_000_000 },
  currentWorkspaceID: "wrk_handler_user",
  workspaces: [
    {
      id: "wrk_handler_user",
      name: "Хувийн орчин",
      slug: null,
      userID: "usr_handler_user",
      role: "admin" as const,
      subscription: null,
      limits: { plan: "free" as const, promoTokens: 1_000, dailyRequests: 20, dailyRequestsFallback: 5 },
      quota: { status: "model-scoped" as const, reason: "free-auto-model-limits" as const },
      usage: {
        scope: "workspace" as const,
        period: "week" as const,
        periodStart: 1_700_000_000_000,
        periodEnd: 1_700_604_800_000,
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

function request(input: { method?: string; origin?: string; workspaceID?: string } = {}) {
  const headers = new Headers()
  if (input.origin !== "") headers.set("origin", input.origin ?? appUrl)
  if (input.workspaceID) headers.set("x-org-id", input.workspaceID)
  return new Request("https://dev.mgpt.mn/v1/account/overview", {
    method: input.method ?? "GET",
    headers,
  })
}

function handler(
  identity: AccountOverviewIdentity,
  load: (input: { accountID: string; email: string; currentWorkspaceID?: string }) => Promise<unknown> = async () =>
    overview,
  input: { origin?: string; workspaceID?: string } = {},
) {
  return accountOverviewRequest(request(input), {
    appUrl,
    authenticate: async () => identity,
    load,
  })
}

describe("account overview route", () => {
  test("returns a schema-validated no-store response to the exact hosted app origin", async () => {
    let selected: string | undefined
    const response = await handler(
      { status: "authenticated", account },
      async (input) => {
        selected = input.currentWorkspaceID
        expect(input).toMatchObject({ accountID: account.id, email: account.email })
        return overview
      },
      { workspaceID: "wrk_handler_user" },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("vary")).toBe("Origin")
    expect(response.headers.get("access-control-allow-origin")).toBe(appUrl)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(selected).toBe("wrk_handler_user")
    expect(await response.json()).toEqual(overview)
  })

  test("permits non-browser bearer clients without reflecting a CORS origin", async () => {
    const response = await handler({ status: "authenticated", account }, undefined, { origin: "" })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("rejects foreign browser origins before authentication", async () => {
    let authenticated = false
    const response = await accountOverviewRequest(request({ origin: "https://attacker.example" }), {
      appUrl,
      authenticate: async () => {
        authenticated = true
        return { status: "authenticated", account }
      },
      load: async () => overview,
    })
    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(authenticated).toBe(false)
  })

  test("returns strict preflight headers only to the configured app", () => {
    const response = accountOverviewPreflight(request({ method: "OPTIONS" }), appUrl)
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(appUrl)
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS")
    expect(response.headers.get("access-control-allow-headers")).toBe("Authorization, X-Org-ID")
    expect(
      accountOverviewPreflight(request({ method: "OPTIONS", origin: "https://attacker.example" }), appUrl).status,
    ).toBe(403)
  })

  test("distinguishes anonymous, suspended, malformed, and unauthorized-workspace requests", async () => {
    expect((await handler({ status: "unauthorized" })).status).toBe(401)
    expect((await handler({ status: "suspended" })).status).toBe(423)
    expect(
      (await handler({ status: "authenticated", account }, undefined, { workspaceID: "not-a-workspace" })).status,
    ).toBe(400)
    for (const error of [new AccountOverviewNotFoundError(), new AccountOverviewWorkspaceAccessError()]) {
      expect(
        (
          await handler({ status: "authenticated", account }, async () => {
            throw error
          })
        ).status,
      ).toBe(403)
    }
    expect(
      (
        await handler({ status: "authenticated", account }, async () => {
          throw new AccountOverviewSuspendedError()
        })
      ).status,
    ).toBe(423)
  })

  test("fails loudly instead of serving an invalid overview contract", async () => {
    expect(
      await handler({ status: "authenticated", account }, async () => ({ account })).catch((error) => error),
    ).toBeInstanceOf(Error)
  })

  test("returns a bounded unavailable stage without exposing the underlying failure", async () => {
    const response = await handler({ status: "authenticated", account }, async () => {
      throw new AccountOverviewUnavailableError("limits", { cause: new Error("secret provider detail") })
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: "account_overview_unavailable",
      stage: "limits",
      message: "Бүртгэлийн мэдээллийг түр ачаалж чадсангүй. Дахин оролдоно уу.",
    })
  })
})
