import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@mongolgpt/core/util/encode"
import { dict as mn } from "../../src/i18n/mn"
import { fixture, pageMessages } from "./session-timeline.fixture"
import { mockMongolGPTServer } from "../utils/mock-server"

const runtimeUrl = process.env.PLAYWRIGHT_HOSTED_RUNTIME_URL ?? "https://runtime.e2e.mgpt.test:4443"
const publicUrl = process.env.PLAYWRIGHT_HOSTED_PUBLIC_URL ?? "https://dev.e2e.mgpt.test"
const tokenUrl = new URL("/auth/runtime-token", `${publicUrl}/`).toString()
const sessionUrl = new URL("/auth/session", `${runtimeUrl}/`).toString()
const overviewUrl = new URL("/v1/account/overview", `${publicUrl}/`).toString()
const capability = (accountID = "account_e2e") => ({
  token: "e2e-runtime-token",
  expiresAt: Date.now() + 60_000,
  account: { id: accountID, email: "e2e@mgpt.mn" },
})

test.describe("hosted MongolGPT account gate", () => {
  test("shows the Mongolian login gate and uses the fixed internal continuation", async ({ page }) => {
    await mockRuntime(page)
    let tokenRequest: { method: string; accept: string; credentials: string } | undefined
    await page.route(tokenUrl, async (route) => {
      tokenRequest = {
        method: route.request().method(),
        accept: route.request().headers().accept ?? "",
        credentials: "include",
      }
      await session(route, 401, { authenticated: false })
    })

    let authorization: URL | undefined
    await page.route(`${publicUrl}/auth/authorize**`, async (route) => {
      authorization = new URL(route.request().url())
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>MongolGPT OAuth</title>",
      })
    })

    await page.goto("/")
    await expect.poll(() => tokenRequest?.method).toBe("POST")
    expect(tokenRequest).toEqual({ method: "POST", accept: "application/json", credentials: "include" })

    await expect(page.getByRole("heading", { name: mn["auth.hosted.title"], exact: true })).toBeVisible()
    await expect(page.getByText(mn["auth.hosted.description"], { exact: true })).toBeVisible()

    const metadata = await page.evaluate(() => ({
      language: document.documentElement.lang,
      mode: document.querySelector('meta[name="mongolgpt-runtime-mode"]')?.getAttribute("content"),
      server: document.querySelector('meta[name="mongolgpt-server-url"]')?.getAttribute("content"),
    }))
    expect(metadata).toEqual({
      language: "mn",
      mode: "hosted",
      server: runtimeUrl,
    })

    await page.getByRole("button", { name: mn["auth.hosted.login"], exact: true }).click()
    await expect.poll(() => authorization?.searchParams.get("continue")).toBe("/auth/app")
    expect(authorization?.origin).toBe(publicUrl)
    expect(authorization?.pathname).toBe("/auth/authorize")
  })

  test("fails closed on HTML auth responses and recovers into a coding session", async ({ page }) => {
    await mockRuntime(page)
    await configureHostedProject(page)

    let state: "unavailable" | "authenticated" = "unavailable"
    let checks = 0
    let currentCapability = capability()
    let exchangeMethod = ""
    let exchangeAuthorization = ""
    await page.route(tokenUrl, async (route) => {
      currentCapability = capability()
      await session(route, 200, currentCapability)
    })
    await page.route(sessionUrl, (route) => {
      checks += 1
      if (state === "unavailable") {
        return session(route, 200, "<!doctype html><title>not an API</title>", "text/html")
      }
      exchangeMethod = route.request().method()
      exchangeAuthorization = route.request().headers().authorization ?? ""
      return session(route, 200, {
        authenticated: true,
        account: { id: currentCapability.account.id },
        expiresAt: currentCapability.expiresAt,
      })
    })

    await page.goto("/")
    await expect(page.getByText(mn["auth.hosted.unavailable"], { exact: true })).toBeVisible()

    state = "authenticated"
    await page.getByRole("button", { name: mn["auth.hosted.retry"], exact: true }).click()
    await expect.poll(() => checks).toBeGreaterThanOrEqual(2)
    expect(exchangeMethod).toBe("POST")
    expect(exchangeAuthorization).toBe(`Bearer ${currentCapability.token}`)

    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
    await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle })).toBeVisible()
    await expect(page.getByRole("textbox", { name: mn["prompt.placeholder.simple"], exact: true })).toBeVisible()
  })

  test("shows plan, quota, and usage in account settings and recovers from an overview failure", async ({ page }) => {
    await mockRuntime(page)
    await configureHostedProject(page)
    await page.context().addCookies([
      {
        name: "mongolgpt_session",
        value: "e2e-session",
        domain: new URL(publicUrl).hostname,
        path: "/",
        secure: true,
        sameSite: "None",
      },
    ])

    let currentCapability = capability("acc_e2e_account")
    let overviewRequests = 0
    let overviewAccept = ""
    let overviewMethod = ""
    let overviewCookie = ""
    let overviewAuthorization = ""
    await page.route(tokenUrl, async (route) => {
      currentCapability = capability("acc_e2e_account")
      await session(route, 200, currentCapability)
    })
    await page.route(sessionUrl, (route) =>
      session(route, 200, {
        authenticated: true,
        account: { id: currentCapability.account.id },
        expiresAt: currentCapability.expiresAt,
      }),
    )
    await page.route(overviewUrl, async (route) => {
      overviewRequests += 1
      const headers = await route.request().allHeaders()
      overviewAccept = headers.accept ?? ""
      overviewMethod = route.request().method()
      overviewCookie = headers.cookie ?? ""
      overviewAuthorization = headers.authorization ?? ""
      if (overviewRequests === 1) return session(route, 503, { error: "temporarily_unavailable" })
      return session(route, 200, accountOverview(currentCapability.account.id))
    })

    await page.goto("/")
    await page.getByRole("button", { name: mn["sidebar.settings"], exact: true }).click()
    await page.getByRole("tab", { name: mn["settings.account.tab"], exact: true }).click()

    await expect(page.getByText(currentCapability.account.email, { exact: true })).toBeVisible()
    await expect(page.getByText(mn["settings.account.overviewLoadError"], { exact: true })).toBeVisible()
    await page.getByRole("button", { name: mn["settings.account.retry"], exact: true }).click()

    await expect.poll(() => overviewRequests).toBe(2)
    expect(overviewMethod).toBe("GET")
    expect(overviewAccept).toBe("application/json")
    expect(overviewCookie).toContain("mongolgpt_session=e2e-session")
    expect(overviewAuthorization).toBe("")
    await expect(page.getByText("MongolGPT баг", { exact: true })).toBeVisible()
    await expect(page.getByText(mn["settings.account.currentWorkspace"], { exact: true })).toBeVisible()
    await expect(page.getByText(mn["settings.account.plan.pro"], { exact: true })).toBeVisible()
    await expect(page.getByText("3 хүсэлт · 123,456 токен", { exact: true })).toBeVisible()
    await expect(page.getByText("Долоо хоногийн хэрэглээ: 123,456 / 1,000,000 токен", { exact: true })).toBeVisible()
    await expect(page.getByText("Долоо хоногийн өртгийн хязгаар: 10%", { exact: true })).toBeVisible()
    await expect(page.getByText("24 цагийн өртгийн хязгаар: 10%", { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    const accountTab = page.getByRole("tab", { name: mn["settings.account.tab"], exact: true })
    await expect(accountTab).toHaveAttribute("title", mn["settings.account.tab"])
    await accountTab.focus()
    await expect(accountTab).toBeFocused()
    await expect(page.getByText("MongolGPT баг", { exact: true })).toBeVisible()
    await expect(page.getByText("Долоо хоногийн хэрэглээ: 123,456 / 1,000,000 токен", { exact: true })).toBeVisible()
    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector(
        '[data-component="dialog-v2"][data-variant="settings"] [data-slot="dialog-container"]',
      )
      const panel = document.querySelector(".settings-v2-panel")
      if (!(dialog instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
        throw new Error("Settings dialog or panel was not found")
      }
      return {
        viewport: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dialog: dialog.scrollWidth - dialog.clientWidth,
        panel: panel.scrollWidth - panel.clientWidth,
      }
    })
    expect(overflow.viewport).toBeLessThanOrEqual(1)
    expect(overflow.dialog).toBeLessThanOrEqual(1)
    expect(overflow.panel).toBeLessThanOrEqual(1)
  })
})

function accountOverview(accountID: string) {
  const periodStart = 1_786_656_000_000
  const periodEnd = 1_787_260_800_000
  return {
    account: { id: accountID, email: "e2e@mgpt.mn", status: "active", createdAt: 1_700_000_000_000 },
    currentWorkspaceID: "wrk_e2e_workspace",
    workspaces: [
      {
        id: "wrk_e2e_workspace",
        name: "MongolGPT баг",
        slug: "mongolgpt-team",
        userID: "usr_e2e_user",
        role: "admin",
        subscription: {
          id: "sub_e2e_active",
          invoiceID: "inv_e2e_paid",
          plan: "pro",
          status: "active",
          periodStart,
          periodEnd,
        },
        limits: {
          plan: "pro",
          weeklyCostLimitInMicroCents: 500_000,
          weeklyTokenLimit: 1_000_000,
          rollingCostLimitInMicroCents: 100_000,
          rollingWindowHours: 24,
        },
        quota: {
          status: "available",
          weeklyCost: { used: 50_000, limit: 500_000, resetAt: periodEnd },
          weeklyTokens: { used: 123_456, limit: 1_000_000, resetAt: periodEnd },
          rollingCost: { used: 10_000, limit: 100_000, resetAt: null },
        },
        usage: {
          scope: "workspace",
          period: "subscription",
          periodStart,
          periodEnd,
          requestCount: 3,
          inputTokens: 100_000,
          outputTokens: 20_000,
          reasoningTokens: 3_000,
          cacheReadTokens: 456,
          cacheWriteTokens: 0,
          totalTokens: 123_456,
          costInMicroCents: 50_000,
        },
      },
    ],
  }
}

async function mockRuntime(page: Page) {
  await mockMongolGPTServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
}

async function configureHostedProject(page: Page) {
  await page.addInitScript(
    ({ directory, server }) => {
      localStorage.setItem(
        "mongolgpt.global.dat:server",
        JSON.stringify({
          projects: { [server]: [{ worktree: directory, expanded: true }] },
          lastProject: { [server]: directory },
        }),
      )
    },
    { directory: fixture.directory, server: runtimeUrl },
  )
}

function session(route: Route, status: number, body: unknown, contentType = "application/json") {
  const origin = route.request().headers()["origin"]
  return route.fulfill({
    status,
    contentType,
    headers: {
      ...(origin ? { "access-control-allow-origin": origin } : {}),
      "access-control-allow-credentials": "true",
      "cache-control": "no-store",
      vary: "Origin",
    },
    body: contentType === "application/json" ? JSON.stringify(body) : String(body),
  })
}
