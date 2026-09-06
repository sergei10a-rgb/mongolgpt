import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { base64Encode } from "@mongolgpt/core/util/encode"
import { mockMongolGPTServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/MongolGPT/ComposerBootstrapRegression"
const projectID = "proj_composer_bootstrap_regression"
const sessionID = "ses_composer_bootstrap_regression"

test("recovers the composer after the scoped agent catalog fails", async ({ page }, testInfo) => {
  const { release } = await setupBootstrapPage(page, "agent")
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  const status = composer.locator('[data-component="prompt-bootstrap-status"]')
  await expect(status).toHaveRole("alert", { timeout: 45_000 })
  await expect(status).toContainText(/агент|agent/i)
  await composer.locator('[contenteditable="true"]').first().fill("Bootstrap retry test")
  await expect(composer.locator('[data-action="prompt-submit"]')).toBeDisabled()
  let promptRequests = 0
  page.on("request", (request) => {
    if (/^\/session\/[^/]+\/prompt_async$/.test(new URL(request.url()).pathname)) promptRequests += 1
  })
  await composer.locator('[contenteditable="true"]').first().press("Enter")
  await page.waitForTimeout(250)
  expect(promptRequests).toBe(0)

  release()
  await status.getByRole("button", { name: /дахин оролдох|retry/i }).click()
  await expect(status).toHaveCount(0, { timeout: 10_000 })
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Thinking Model")
  await expect(composer.locator('[data-action="prompt-submit"]')).toBeEnabled()
  await screenshot(page, testInfo, "agent-recovered")
})

test("recovers the composer after the directory provider catalog fails", async ({ page }, testInfo) => {
  const { release } = await setupBootstrapPage(page, "directory-provider")
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  const status = composer.locator('[data-component="prompt-bootstrap-status"]')
  await expect(status).toHaveRole("alert", { timeout: 45_000 })
  await expect(status).toContainText(/төслийн|project/i)
  await composer.locator('[contenteditable="true"]').first().fill("Bootstrap retry test")
  await expect(composer.locator('[data-action="prompt-submit"]')).toBeDisabled()

  release()
  await status.getByRole("button", { name: /дахин оролдох|retry/i }).click()
  await expect(status).toHaveCount(0, { timeout: 10_000 })
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Thinking Model")
  await expect(composer.locator('[data-action="prompt-submit"]')).toBeEnabled()
  await screenshot(page, testInfo, "directory-provider-recovered")
})

test("keeps the selected model usable during a live provider catalog refresh", async ({ page }, testInfo) => {
  const refresh = await setupBootstrapPage(page, undefined, { refresh: true })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  const model = composer.locator('[data-action="prompt-model"]')
  const submit = composer.locator('[data-action="prompt-submit"]')
  const status = composer.locator('[data-component="prompt-bootstrap-status"]')
  await expect(model).toContainText("Thinking Model")
  await composer.locator('[contenteditable="true"]').first().fill("Live catalog refresh test")
  await expect(submit).toBeEnabled()

  refresh.trigger()
  await expect.poll(() => refresh.started(), { timeout: 10_000 }).toBe(true)
  await expect(status).toHaveCount(0)
  await expect(model).toContainText("Thinking Model")
  await expect(submit).toBeEnabled()

  refresh.releaseRefresh()
  await expect(model).toContainText("Refreshed Model", { timeout: 10_000 })
  await expect(status).toHaveCount(0)
  await expect(submit).toBeEnabled()
  await screenshot(page, testInfo, "provider-refresh-recovered")
})

async function setupBootstrapPage(
  page: Page,
  failure?: "agent" | "directory-provider",
  options?: { refresh?: boolean },
) {
  let released = false
  let refreshTriggered = false
  let refreshReleased = false
  let refreshStarted = false
  let releaseRefresh!: () => void
  const events: unknown[] = []
  const refreshProvider = {
    all: [
      {
        id: "mongolgpt",
        name: "MongolGPT",
        models: { "thinking-model": { id: "thinking-model", name: "Refreshed Model", limit: { context: 200_000 } } },
      },
    ],
    connected: ["mongolgpt"],
    default: { mongolgpt: "thinking-model" },
  }
  const refreshRelease = new Promise<void>((resolve) => {
    releaseRefresh = resolve
  })
  await mockMongolGPTServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-bootstrap-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "mongolgpt",
          name: "MongolGPT",
          models: { "thinking-model": { id: "thinking-model", name: "Thinking Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["mongolgpt"],
      default: { mongolgpt: "thinking-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: "Composer bootstrap regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, events.length),
    eventRetry: 16,
  })
  await page.route("**/*", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    const url = new URL(route.request().url())
    const path = url.pathname
    const directoryRequest = !!url.searchParams.get("directory") || !!route.request().headers()["x-mongolgpt-directory"]
    const failed = failure === "agent" ? path.endsWith("/agent") : path.endsWith("/provider") && directoryRequest
    if (failure && failed && !released) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": route.request().headers().origin ?? "*",
          "access-control-allow-credentials": "true",
        },
        body: JSON.stringify({ error: "temporary" }),
      })
      return
    }
    if (options?.refresh && refreshTriggered && path.endsWith("/provider") && directoryRequest) {
      refreshStarted = true
      if (!refreshReleased) {
        await refreshRelease
        refreshReleased = true
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": route.request().headers().origin ?? "*",
          "access-control-allow-credentials": "true",
        },
        body: JSON.stringify(refreshProvider),
      })
      return
    }
    return route.fallback()
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  return {
    release: () => {
      released = true
    },
    trigger: () => {
      refreshTriggered = true
      events.push({ directory: "global", payload: { type: "models-dev.refreshed" } })
    },
    started: () => refreshStarted,
    releaseRefresh: () => {
      refreshReleased = true
      releaseRefresh()
    },
  }
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false })
}
