import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@mongolgpt/core/util/encode"
import { fixture, pageMessages } from "./session-timeline.fixture"
import { mockMongolGPTServer } from "../utils/mock-server"

const runtimeUrl = process.env.PLAYWRIGHT_HOSTED_RUNTIME_URL ?? "https://runtime.e2e.mgpt.test:4443"
const publicUrl = process.env.PLAYWRIGHT_HOSTED_PUBLIC_URL ?? "https://dev.e2e.mgpt.test"
const sessionUrl = new URL("/auth/session", `${runtimeUrl}/`).toString()

test.describe("hosted MongolGPT account gate", () => {
  test("shows the Mongolian login gate and uses the fixed internal continuation", async ({ page }) => {
    await mockRuntime(page)
    await page.route(sessionUrl, (route) => session(route, 401, { authenticated: false }))

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

    await expect(page.getByRole("heading", { name: "MongolGPT-д нэвтэрнэ үү" })).toBeVisible()
    await expect(page.getByText("Web хувилбарыг ашиглахын тулд MongolGPT аккаунтаараа нэвтэрнэ үү.")).toBeVisible()

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

    await page.getByRole("button", { name: "Нэвтрэх" }).click()
    await expect.poll(() => authorization?.searchParams.get("continue")).toBe("/auth/app")
    expect(authorization?.origin).toBe(publicUrl)
    expect(authorization?.pathname).toBe("/auth/authorize")
  })

  test("fails closed on HTML auth responses and recovers into a coding session", async ({ page }) => {
    await mockRuntime(page)
    await configureHostedProject(page)

    let state: "unavailable" | "authenticated" = "unavailable"
    let checks = 0
    await page.route(sessionUrl, (route) => {
      checks += 1
      if (state === "unavailable") {
        return session(route, 200, "<!doctype html><title>not an API</title>", "text/html")
      }
      return session(route, 200, {
        authenticated: true,
        account: { id: "account_e2e", email: "e2e@mgpt.mn" },
      })
    })

    await page.goto("/")
    await expect(page.getByText("Аккаунтыг шалгаж чадсангүй. Дахин оролдоно уу.")).toBeVisible()

    state = "authenticated"
    await page.getByRole("button", { name: "Дахин шалгах" }).click()
    await expect.poll(() => checks).toBeGreaterThanOrEqual(2)

    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
    await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle })).toBeVisible()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible()
  })
})

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
