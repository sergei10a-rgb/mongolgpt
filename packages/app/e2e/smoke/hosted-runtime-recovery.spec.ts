import { expect, test } from "@playwright/test"
import { issueRuntimeCapability } from "@mongolgpt/runtime-auth"
import { runtimeReadRetryHeader } from "@mongolgpt/runtime-auth/read-retry"
import { createRuntimeHandler, type RuntimeVariables } from "../../../runtime/src/runtime"
import { base64Encode } from "@mongolgpt/core/util/encode"
import { mockMongolGPTServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"
import { fixture, pageMessages } from "./session-timeline.fixture"

const runtime = process.env.PLAYWRIGHT_HOSTED_RUNTIME_URL ?? "https://runtime.e2e.mgpt.test:4443"
const consoleOrigin = process.env.PLAYWRIGHT_HOSTED_PUBLIC_URL ?? "https://dev.e2e.mgpt.test"
const app = "https://app.e2e.mgpt.test"
const secret = "isolated-browser-runtime-auth-test-secret-32-characters"
const account = { id: "acc_browser_retry", email: "retry@example.com" }
const workspace = { id: "wrk_browser_retry", name: "MongolGPT" }

for (const viewport of [
  { width: 1365, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`refreshes the actual runtime cookie during cold admission at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport)
    const errors = trackPageErrors(page)
    const preview = testInfo.project.use.baseURL!
    // The HTTPS test origin has no Vite websocket endpoint; HMR is not part of the auth fixture.
    await page.routeWebSocket(
      (url) => url.origin === app.replace("https:", "wss:") && url.pathname === "/" && url.searchParams.has("token"),
      (socket) => {
        socket.send(JSON.stringify({ type: "connected" }))
      },
    )
    // Keep the real HTTPS same-site cookie policy, while serving only this build's assets locally.
    await page.route(`${app}/**`, async (route) => {
      const source = new URL(route.request().url())
      const response = await route.fetch({ url: new URL(source.pathname + source.search, preview).toString() })
      await route.fulfill({ response })
    })
    await mockMongolGPTServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
    })
    await page.addInitScript(
      ({ origin, workspaceID }) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
        localStorage.setItem(`mongolgpt.hosted.workspace.v1:${origin}`, workspaceID)
      },
      { origin: consoleOrigin, workspaceID: workspace.id },
    )

    let issued = 0
    let exchanges = 0
    let expired = 0
    let retries = 0
    let forwarded = 0
    let initialCookie = ""
    let freshCookie = false
    let warming: Promise<void> | undefined
    const env: RuntimeVariables = {
      MONGOLGPT_APP_ORIGIN: app,
      MONGOLGPT_CONSOLE_URL: consoleOrigin,
      MONGOLGPT_RUNTIME_AUTH_SECRET: secret,
      MONGOLGPT_RUNTIME_SECRET: "isolated-browser-runtime-server-test-secret-32-characters",
      MONGOLGPT_RUNTIME_VERSION: "browser-recovery-test",
      MONGOLGPT_RUNTIME_BURST_LIMITER: { limit: async () => ({ success: true }) },
      MONGOLGPT_RUNTIME_RATE_LIMITER: { limit: async () => ({ success: true }) },
      STAGE: "dev",
    }
    const handler = createRuntimeHandler({
      sandbox: () => ({
        getProcess: async () => ({
          status: "running",
          getStatus: async () => "running",
          waitForPort: async () => {
            warming ??= new Promise((resolve) => setTimeout(resolve, 5100))
            await warming
          },
        }),
        startProcess: async () => {
          throw new Error("Unexpected duplicate start")
        },
        containerFetch: async (request) => {
          forwarded++
          expect(request.headers.get("cookie")).toBeNull()
          expect(request.headers.get(runtimeReadRetryHeader)).toBeNull()
          return Response.json(fixture.provider)
        },
        wsConnect: async () => {
          throw new Error("Unexpected websocket")
        },
      }),
    })

    await page.route(`${consoleOrigin}/auth/runtime-token`, async (route) => {
      const now = Math.floor(Date.now() / 1000) - (issued++ === 0 ? 55 : 0)
      const token = await issueRuntimeCapability({
        accountID: account.id,
        workspaceID: workspace.id,
        authVersion: 1,
        audience: runtime,
        secret,
        ttlSeconds: 60,
        now,
      })
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": app, "access-control-allow-credentials": "true" },
        body: JSON.stringify({ token, expiresAt: (now + 60) * 1000, account, workspace }),
      })
    })
    await page.route(
      (url) => url.origin === runtime && ["/provider", "/auth/session"].includes(url.pathname),
      async (route) => {
        const source = route.request()
        const headers = await source.allHeaders()
        const request = new Request(source.url(), {
          method: source.method(),
          headers,
          body: source.postDataBuffer() ?? undefined,
        })
        if (request.method === "GET") {
          const cookie = request.headers.get("cookie") ?? ""
          if (!initialCookie) initialCookie = cookie
          if (request.headers.has(runtimeReadRetryHeader)) {
            retries++
            freshCookie ||= cookie.length > 0 && cookie !== initialCookie
          }
        }
        const response = await handler(request, env)
        if (new URL(request.url).pathname === "/auth/session" && request.method === "POST" && response.ok) exchanges++
        if (response.status === 401 && response.headers.has(runtimeReadRetryHeader)) expired++
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        })
      },
    )

    await page.goto(`${app}/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
    const composer = page.locator('[data-component="session-composer"]')
    await expect(composer).toBeVisible()
    const status = composer.locator('[data-component="prompt-bootstrap-status"]')
    await expect(status).toHaveRole("status")
    await expect.poll(() => exchanges).toBeGreaterThanOrEqual(2)
    await expect.poll(() => retries).toBeGreaterThan(0)
    await expect(status).toHaveCount(0)
    expect(expired).toBe(retries)
    expect(freshCookie).toBe(true)
    expect(forwarded).toBeGreaterThan(0)
    await composer.locator('[contenteditable="true"]').first().fill("Refreshed runtime session")
    await expect(composer.locator('[data-action="prompt-submit"]')).toBeEnabled()
    const network401 = "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
    expect(errors.filter((error) => error !== network401)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath("runtime-cookie-recovered.png") })
  })
}
