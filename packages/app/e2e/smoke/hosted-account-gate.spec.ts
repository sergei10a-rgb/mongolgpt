import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@mongolgpt/core/util/encode"
import { dict as mn } from "../../src/i18n/mn"
import { fixture, pageMessages } from "./session-timeline.fixture"
import { mockMongolGPTServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"

const runtimeUrl = process.env.PLAYWRIGHT_HOSTED_RUNTIME_URL ?? "https://runtime.e2e.mgpt.test:4443"
const publicUrl = process.env.PLAYWRIGHT_HOSTED_PUBLIC_URL ?? "https://dev.e2e.mgpt.test"
const tokenUrl = new URL("/auth/runtime-token", `${publicUrl}/`).toString()
const sessionUrl = new URL("/auth/session", `${runtimeUrl}/`).toString()
const overviewUrl = new URL("/v1/account/overview", `${publicUrl}/`).toString()
const capability = (accountID = "account_e2e", token = "e2e-runtime-token") => ({
  token,
  expiresAt: Date.now() + 60_000,
  account: { id: accountID, email: "e2e@mgpt.mn" },
  workspace: { id: "wrk_e2e_workspace", name: "MongolGPT баг" },
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
    let issued = 0
    const capabilities = new Map<string, ReturnType<typeof capability>>()
    let exchangeMethod = ""
    let exchangeAuthorization = ""
    await page.route(tokenUrl, async (route) => {
      const current = capability("account_e2e", `e2e-runtime-token-${++issued}`)
      capabilities.set(current.token, current)
      await session(route, 200, current)
    })
    await page.route(sessionUrl, (route) => {
      checks += 1
      if (state === "unavailable") {
        return session(route, 200, "<!doctype html><title>not an API</title>", "text/html")
      }
      exchangeMethod = route.request().method()
      exchangeAuthorization = route.request().headers().authorization ?? ""
      const current = capabilities.get(exchangeAuthorization.replace(/^Bearer\s+/, ""))
      if (!current) return session(route, 401, { authenticated: false })
      return session(route, 200, {
        authenticated: true,
        account: { id: current.account.id },
        workspace: { id: current.workspace.id },
        expiresAt: current.expiresAt,
      })
    })

    await page.goto("/")
    await expect(page.getByText(mn["auth.hosted.unavailable"], { exact: true })).toBeVisible()

    state = "authenticated"
    await page.getByRole("button", { name: mn["auth.hosted.retry"], exact: true }).click()
    await expect.poll(() => checks).toBeGreaterThanOrEqual(2)
    expect(exchangeMethod).toBe("POST")
    expect(capabilities.has(exchangeAuthorization.replace(/^Bearer\s+/, ""))).toBe(true)

    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
    await expectVisibleOrAppError(page, page.getByRole("heading", { name: fixture.expected.sourceTitle }))
    await expectVisibleOrAppError(
      page,
      page.getByRole("textbox", { name: mn["prompt.placeholder.simple"], exact: true }),
    )
  })

  test("opens an empty hosted workspace root for a signed-in user", async ({ page }) => {
    const errors = trackPageErrors(page)
    let eventRequests = 0
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/global/event") eventRequests++
    })
    await mockRuntime(page, {
      directory: "/workspace",
      home: "/workspace",
      project: { ...fixture.project, worktree: "/workspace", sandboxes: [] },
      sessions: [],
    })

    const current = capability("account_empty_workspace_e2e")
    await page.route(tokenUrl, (route) => session(route, 200, current))
    await page.route(sessionUrl, (route) =>
      session(route, 200, {
        authenticated: true,
        account: { id: current.account.id },
        workspace: { id: current.workspace.id },
        expiresAt: current.expiresAt,
      }),
    )

    await page.goto("/")
    await expect(page.getByText(mn["home.sessions.empty.noProject.webDescription"], { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: mn["dialog.server.bridge.button"], exact: true })).toBeVisible()
    const openProject = page.getByRole("button", { name: mn["home.project.openCloud"], exact: true })
    await expect(openProject).toBeVisible()
    await openProject.click()

    const dialog = page.getByRole("dialog")
    await expect(dialog.getByRole("heading", { name: mn["home.project.openCloud"], exact: true })).toBeVisible()
    const workspaceRoot = dialog.getByText("~", { exact: true })
    await expect(workspaceRoot).toBeVisible()
    await workspaceRoot.click()

    await expect(dialog).toBeHidden()
    const newSession = page.locator('[data-action="home-new-session"]')
    await expect(newSession).toBeVisible()
    await newSession.click()
    await expect(page.getByRole("textbox", { name: mn["prompt.placeholder.simple"], exact: true })).toBeVisible()
    await expect.poll(() => eventRequests).toBeGreaterThan(0)
    expectNoSmokeErrors(errors, [], [])
  })

  test("fails closed to Desktop pairing when the hosted runtime has no filesystem root", async ({ page }) => {
    const errors = trackPageErrors(page)
    let eventRequests = 0
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/global/event") eventRequests++
    })
    await mockRuntime(page)
    await page.route(`${runtimeUrl}/path**`, (route) =>
      session(route, 200, { state: "", config: "", worktree: "", directory: "", home: "" }),
    )
    await page.route(`${runtimeUrl}/project**`, (route) => session(route, 200, []))

    const current = capability("account_no_cloud_root_e2e")
    await page.route(tokenUrl, (route) => session(route, 200, current))
    await page.route(sessionUrl, (route) =>
      session(route, 200, {
        authenticated: true,
        account: { id: current.account.id },
        workspace: { id: current.workspace.id },
        expiresAt: current.expiresAt,
      }),
    )

    await page.goto("/")
    await expect(page.getByText(mn["home.empty.webBridgeDescription"], { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: mn["dialog.server.bridge.button"], exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: mn["home.project.openCloud"], exact: true })).toHaveCount(0)
    await expect(page.locator('[data-action="home-add-project"]')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(eventRequests).toBe(0)
    expectNoSmokeErrors(errors, [], [])
  })

  test("shows a safe Mongolian diagnostic when the hosted runtime cannot become ready", async ({ page }) => {
    const errors = trackPageErrors(page)
    const message = "Cloud runtime сервер хугацаандаа бэлэн болсонгүй."
    let pathRequests = 0
    await mockRuntime(page)
    await page.route(`${runtimeUrl}/path**`, (route) => {
      pathRequests += 1
      return session(route, 502, {
        error: "runtime_process_port_timeout",
        code: "runtime_process_port_timeout",
        message,
      })
    })

    const current = capability("account_runtime_failure_e2e")
    await page.route(tokenUrl, (route) => session(route, 200, current))
    await page.route(sessionUrl, (route) =>
      session(route, 200, {
        authenticated: true,
        account: { id: current.account.id },
        workspace: { id: current.workspace.id },
        expiresAt: current.expiresAt,
      }),
    )

    await page.goto("/")
    await expect.poll(() => pathRequests).toBeGreaterThan(0)
    const toast = page.locator('[data-component="toast"][data-variant="error"], [data-component="toast-v2"]')
    await expect(toast.getByText(mn["common.requestFailed"], { exact: true })).toBeVisible()
    await expect(toast.getByText(message, { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: mn["home.project.openCloud"], exact: true })).toHaveCount(0)
    const expectedNetworkError = "Failed to load resource: the server responded with a status of 502 (Bad Gateway)"
    expect(errors.filter((error) => error === expectedNetworkError).length).toBeGreaterThan(0)
    expectNoSmokeErrors(
      errors.filter((error) => error !== expectedNetworkError),
      [],
      [],
    )
  })

  test("requires and verifies a workspace choice before opening the hosted app", async ({ page }) => {
    await mockRuntime(page)
    await configureHostedProject(page)
    const account = { id: "account_multi_e2e", email: "multi@mgpt.mn" }
    const workspaces = [
      { id: "wrk_personal", name: "Хувийн workspace" },
      { id: "wrk_research", name: "Судалгааны баг" },
    ]
    const capabilities = new Map<string, ReturnType<typeof capability>>()
    const requested: Array<string | undefined> = []

    await page.route(tokenUrl, async (route) => {
      const workspaceID = route.request().headers()["x-org-id"]
      requested.push(workspaceID)
      if (!workspaceID) {
        return session(route, 409, {
          error: "workspace_required",
          message: "Ашиглах ажлын талбараа сонгоно уу.",
          account,
          workspaces,
        })
      }
      const workspace = workspaces.find((item) => item.id === workspaceID)
      if (!workspace) return session(route, 403, { account, workspaces })
      const current = { ...capability(account.id, `token-${workspace.id}`), workspace }
      capabilities.set(current.token, current)
      return session(route, 200, current)
    })
    await page.route(sessionUrl, (route) => {
      const token =
        route
          .request()
          .headers()
          .authorization?.replace(/^Bearer\s+/, "") ?? ""
      const current = capabilities.get(token)
      if (!current) return session(route, 401, { authenticated: false })
      return session(route, 200, {
        authenticated: true,
        account: { id: current.account.id },
        workspace: { id: current.workspace.id },
        expiresAt: current.expiresAt,
      })
    })

    await page.goto("/")
    await expect(page.getByText(mn["onboarding.workspace.description"], { exact: true })).toBeVisible()
    const researchRow = page.getByText("Судалгааны баг", { exact: true }).locator("..")
    await researchRow.getByRole("button", { name: mn["onboarding.workspace.select"], exact: true }).click()

    await expect(page.getByRole("heading", { name: mn["auth.hosted.title"], exact: true })).toBeHidden()
    await expect.poll(() => requested.includes("wrk_research")).toBe(true)
    await expect
      .poll(() => page.evaluate((origin) => localStorage.getItem(`mongolgpt.hosted.workspace.v1:${origin}`), publicUrl))
      .toBe("wrk_research")
  })

  test("keeps optional BYOK and custom provider flows available after account login when managed Free Auto is unavailable", async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await mockRuntime(page, {
      provider: providerCatalog(),
    })
    await configureHostedProject(page)

    const current = capability("account_byok_e2e")
    await page.route(tokenUrl, (route) => session(route, 200, current))
    await page.route(sessionUrl, (route) =>
      session(route, 200, {
        authenticated: true,
        account: { id: current.account.id },
        workspace: { id: current.workspace.id },
        expiresAt: current.expiresAt,
      }),
    )

    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
    await expectVisibleOrAppError(
      page,
      page.getByRole("textbox", { name: mn["prompt.placeholder.simple"], exact: true }),
    )

    await page.locator('[data-action="prompt-model"]').click()
    await expect(page.getByText(mn["dialog.model.unpaid.freeModels.title"], { exact: true })).toBeVisible()
    await expect(page.getByText("MongolGPT Free Auto", { exact: true })).toHaveCount(0)

    await page.getByRole("button", { name: mn["dialog.provider.viewAll"], exact: true }).click()
    await page.getByText(mn["settings.providers.tag.custom"], { exact: true }).first().click()

    await expect(page.getByText(mn["provider.custom.title"], { exact: true })).toBeVisible()
    await expect(page.getByLabel(mn["provider.custom.field.providerID.label"], { exact: true })).toBeVisible()
    expectNoSmokeErrors(errors, [], [])
  })

  test("sends a hosted mongolgpt/free-auto prompt after login and workspace selection", async ({ page }) => {
    const capabilities = new Map<string, ReturnType<typeof capability>>()
    const requested: Array<string | undefined> = []
    const account = { id: "account_free_auto_e2e", email: "free-auto@mgpt.mn" }
    const workspaces = [{ id: "wrk_e2e_workspace", name: "MongolGPT баг" }]
    let issued = 0
    let promptRequest:
      | {
          sessionID: string
          model?: { providerID?: string; modelID?: string }
          text: string
        }
      | undefined

    await mockRuntime(page, {
      provider: providerCatalog({
        connected: ["mongolgpt"],
        defaults: { mongolgpt: "free-auto" },
        providers: [
          {
            id: "mongolgpt",
            name: "MongolGPT",
            models: {
              "free-auto": {
                id: "free-auto",
                name: "MongolGPT Free Auto",
                limit: { context: 200_000 },
                cost: { input: 0, output: 0 },
              },
            },
          },
        ],
      }),
    })
    await configureHostedProject(page)

    await page.route(tokenUrl, async (route) => {
      const workspaceID = route.request().headers()["x-org-id"]
      requested.push(workspaceID)
      if (!workspaceID) {
        return session(route, 409, {
          error: "workspace_required",
          message: "Ашиглах ажлын талбараа сонгоно уу.",
          account,
          workspaces,
        })
      }
      const workspace = workspaces.find((item) => item.id === workspaceID)
      if (!workspace) return session(route, 403, { account, workspaces })
      const current = { ...capability(account.id, `token-${workspace.id}-${++issued}`), workspace }
      capabilities.set(current.token, current)
      return session(route, 200, current)
    })
    await page.route(sessionUrl, (route) => {
      const token =
        route
          .request()
          .headers()
          .authorization?.replace(/^Bearer\s+/, "") ?? ""
      const current = capabilities.get(token)
      if (!current) return session(route, 401, { authenticated: false })
      return session(route, 200, {
        authenticated: true,
        account: { id: current.account.id },
        workspace: { id: current.workspace.id },
        expiresAt: current.expiresAt,
      })
    })
    await page.route(`${runtimeUrl}/session/**/prompt_async`, async (route) => {
      const match = new URL(route.request().url()).pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
      if (!match || route.request().method() !== "POST") return route.fallback()
      const body = route.request().postDataJSON() as Record<string, unknown>
      const parts = Array.isArray(body.parts) ? body.parts : []
      promptRequest = {
        sessionID: match[1]!,
        model: record(body.model) ? body.model : undefined,
        text: parts
          .filter((part): part is Record<string, unknown> => record(part) && part.type === "text")
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join(""),
      }
      return route.fulfill({
        status: 204,
        headers: {
          ...corsHeaders(route),
          "cache-control": "no-store",
        },
        body: "",
      })
    })

    await page.goto("/")
    await expect(page.getByText(mn["onboarding.workspace.description"], { exact: true })).toBeVisible()
    await page.getByRole("button", { name: mn["onboarding.workspace.select"], exact: true }).click()
    await expect.poll(() => requested.includes("wrk_e2e_workspace")).toBe(true)
    await expect
      .poll(() => page.evaluate((origin) => localStorage.getItem(`mongolgpt.hosted.workspace.v1:${origin}`), publicUrl))
      .toBe("wrk_e2e_workspace")
    const errors = trackPageErrors(page)

    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
    const composer = page.getByRole("textbox", { name: mn["prompt.placeholder.simple"], exact: true })
    await expectVisibleOrAppError(page, composer)
    await expect(page.locator('[data-action="prompt-model"]')).toContainText("MongolGPT Free Auto")

    await composer.click()
    await page.keyboard.type("Free Auto smoke prompt")
    await page.getByRole("button", { name: mn["prompt.action.send"], exact: true }).click()

    await expect(page).toHaveURL(new RegExp(`/session/${fixture.sourceID}$`))
    await expect.poll(() => promptRequest?.sessionID).toBe(fixture.sourceID)
    expect(promptRequest).toMatchObject({
      sessionID: fixture.sourceID,
      model: { providerID: "mongolgpt", modelID: "free-auto" },
      text: "Free Auto smoke prompt",
    })
    expectNoSmokeErrors(errors, [], [])
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
        workspace: { id: currentCapability.workspace.id },
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
    await expect(page.getByText("Ажлын орчны хэрэглээ: 3 хүсэлт · 123,456 токен", { exact: true })).toBeVisible()
    await expect(page.getByText("Таны 7 хоногийн токен: 123,456 / 1,000,000", { exact: true })).toBeVisible()
    await expect(page.getByText("Таны 7 хоногийн хүсэлт: 100 / 1,000", { exact: true })).toBeVisible()
    await expect(page.getByText("Таны сарын токен: 500,000 / 4,000,000", { exact: true })).toBeVisible()
    await expect(page.getByText("Таны сарын хүсэлт: 500 / 4,000", { exact: true })).toBeVisible()
    await expect(page.getByText("Таны 7 хоногийн өртгийн хязгаар: 10%", { exact: true })).toBeVisible()
    await expect(page.getByText("Таны сарын өртгийн хязгаар: 10%", { exact: true })).toBeVisible()
    await expect(page.getByText("Таны 24 цагийн өртгийн хязгаар: 10%", { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    const accountTab = page.getByRole("tab", { name: mn["settings.account.tab"], exact: true })
    await expect(accountTab).toHaveAttribute("title", mn["settings.account.tab"])
    await accountTab.focus()
    await expect(accountTab).toBeFocused()
    await expect(page.getByText("MongolGPT баг", { exact: true })).toBeVisible()
    await expect(page.getByText("Таны 7 хоногийн токен: 123,456 / 1,000,000", { exact: true })).toBeVisible()
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

  test("starts a secure Desktop pairing from the Mongolian server settings", async ({ page }) => {
    await mockRuntime(page)
    await configureHostedProject(page)
    const current = capability("account_bridge_e2e")
    await page.route(tokenUrl, (route) => session(route, 200, current))
    await page.route(sessionUrl, (route) =>
      session(route, 200, {
        authenticated: true,
        account: { id: current.account.id },
        workspace: { id: current.workspace.id },
        expiresAt: current.expiresAt,
      }),
    )
    await page.addInitScript(() => {
      window.addEventListener(
        "click",
        (event) => {
          const link = event.target instanceof Element ? event.target.closest("a") : null
          if (!(link instanceof HTMLAnchorElement) || !link.href.startsWith("mongolgpt://")) return
          event.preventDefault()
          event.stopImmediatePropagation()
          ;(window as Window & { __mongolgptPairingURL?: string }).__mongolgptPairingURL = link.href
        },
        true,
      )
    })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/")
    await page.getByRole("button", { name: mn["sidebar.settings"], exact: true }).click()
    await page.getByRole("tab", { name: mn["status.popover.tab.servers"], exact: true }).click()
    const connect = page.getByRole("button", { name: mn["dialog.server.bridge.button"], exact: true })
    await expect(connect).toBeVisible()
    await connect.click()

    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { __mongolgptPairingURL?: string }).__mongolgptPairingURL ?? null),
      )
      .not.toBeNull()
    const captured = await page.evaluate(
      () => (window as Window & { __mongolgptPairingURL?: string }).__mongolgptPairingURL!,
    )
    const pairing = new URL(captured)
    expect(pairing.protocol).toBe("mongolgpt:")
    expect(pairing.host).toBe("bridge")
    expect(pairing.pathname).toBe("/pair")
    expect(pairing.searchParams.get("account_id")).toBe(current.account.id)

    const pendingRaw = await page.evaluate(() => localStorage.getItem("mongolgpt.local-bridge.pending-v1"))
    expect(pendingRaw).not.toBeNull()
    const pending: unknown = JSON.parse(pendingRaw!)
    if (!isBridgePending(pending)) throw new Error("Bridge pairing state was not stored safely")
    expect(pending.accountID).toBe(current.account.id)
    expect(pairing.searchParams.get("state")).toBe(pending.state)
    expect(captured).not.toContain(pending.verifier)
    expect(await connect.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
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
          weeklyRequestLimit: 1_000,
          monthlyCostLimitInMicroCents: 2_000_000,
          monthlyTokenLimit: 4_000_000,
          monthlyRequestLimit: 4_000,
          rollingCostLimitInMicroCents: 100_000,
          rollingWindowHours: 24,
        },
        quota: {
          status: "available",
          scope: "user",
          weeklyCost: { used: 50_000, limit: 500_000, resetAt: periodEnd },
          weeklyTokens: { used: 123_456, limit: 1_000_000, resetAt: periodEnd },
          weeklyRequests: { used: 100, limit: 1_000, resetAt: periodEnd },
          monthlyCost: { used: 200_000, limit: 2_000_000, resetAt: periodEnd },
          monthlyTokens: { used: 500_000, limit: 4_000_000, resetAt: periodEnd },
          monthlyRequests: { used: 500, limit: 4_000, resetAt: periodEnd },
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

async function mockRuntime(page: Page, overrides: Partial<Parameters<typeof mockMongolGPTServer>[1]> = {}) {
  await mockMongolGPTServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    ...overrides,
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
  return route.fulfill({
    status,
    contentType,
    headers: {
      ...corsHeaders(route),
      "cache-control": "no-store",
    },
    body: contentType === "application/json" ? JSON.stringify(body) : String(body),
  })
}

function corsHeaders(route: Route) {
  const origin = route.request().headers()["origin"]
  return {
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-credentials": "true",
    vary: "Origin",
  }
}

function providerCatalog(input?: {
  connected?: string[]
  defaults?: Record<string, string>
  providers?: Array<Record<string, unknown>>
}) {
  return {
    all: input?.providers ?? [],
    connected: input?.connected ?? [],
    default: input?.defaults ?? {},
  }
}

function isBridgePending(value: unknown): value is {
  verifier: string
  state: string
  accountID: string
  expiresAt: number
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return (
    "verifier" in value &&
    typeof value.verifier === "string" &&
    "state" in value &&
    typeof value.state === "string" &&
    "accountID" in value &&
    typeof value.accountID === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number"
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function expectVisibleOrAppError(page: Page, target: Locator) {
  const error = page.getByRole("heading", { name: mn["error.page.title"], exact: true })
  const outcome = await Promise.race([
    target.waitFor({ state: "visible" }).then(() => "visible" as const),
    error.waitFor({ state: "visible" }).then(() => "error" as const),
  ])
  if (outcome === "visible") return

  const label = mn["error.page.details.label"]
  await page.getByRole("button", { name: label, exact: true }).click()
  const details = await page.getByRole("textbox", { name: label, exact: true }).inputValue()
  throw new Error(`MongolGPT app crash: ${details}`)
}
