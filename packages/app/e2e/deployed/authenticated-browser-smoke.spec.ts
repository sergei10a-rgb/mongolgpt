import { expect, test } from "@playwright/test"
import { AccountOverviewSchema, type AccountOverview } from "@mongolgpt/account-contract"
import {
  expectNoDeployedSmokeFailures,
  installSmokeAuthCookie,
  isVisibleMongolianText,
  observeDeployedPage,
} from "./network"

test.use({ trace: "off", screenshot: "off", video: "off" })

test("proves the deployed runtime boundary from an authenticated browser session", async ({ page }) => {
  const appOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_BASE_URL!).origin
  const publicOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_PUBLIC_URL!).origin
  const runtimeOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_RUNTIME_URL!).origin
  const hasAuthCookie = await installSmokeAuthCookie(page.context(), publicOrigin)
  test.skip(!hasAuthCookie, "Set MONGOLGPT_SMOKE_AUTH_COOKIE to run the authenticated deployed smoke test locally.")

  const state = observeDeployedPage(page, appOrigin, [publicOrigin, runtimeOrigin], [publicOrigin])

  await page.goto("/", { waitUntil: "domcontentloaded" })
  expect(new URL(page.url()).origin).toBe(appOrigin)
  expect(new URL(page.url()).pathname).toBe("/")

  await expect(page.getByRole("heading", { name: "MongolGPT-д нэвтэрнэ үү" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Тохиргоо" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Юу ч асуу..." })).toBeVisible()

  const snapshot = await page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    text: document.body.innerText,
    readyState: document.readyState,
  }))
  expect(snapshot.title).toContain("MongolGPT")
  expect(snapshot.lang).toBe("mn")
  expect(snapshot.readyState).not.toBe("loading")
  expect(isVisibleMongolianText(snapshot.text)).toBe(true)

  await expect
    .poll(() => hasAuthenticatedApiResponse(state, publicOrigin, "/auth/runtime-token", "POST", 200), {
      message: "authenticated deployed app did not issue a valid runtime capability",
    })
    .toBe(true)
  await expect
    .poll(() => hasAuthenticatedApiResponse(state, runtimeOrigin, "/auth/session", "POST", 200), {
      message: "authenticated deployed app did not exchange the runtime capability",
    })
    .toBe(true)

  expectAuthenticatedApiResponse(state, publicOrigin, "/auth/runtime-token", "POST", 200)
  expectAuthenticatedApiResponse(state, runtimeOrigin, "/auth/session", "POST", 200)

  const overview = await page.evaluate(
    async (url) => {
      const response = await fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json" },
      })
      return {
        url: response.url,
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        body: await response.text(),
      }
    },
    new URL("/v1/account/overview", `${publicOrigin}/`).toString(),
  )
  expect(new URL(overview.url).origin).toBe(publicOrigin)
  expect(overview.status).toBe(200)
  expect(overview.contentType?.split(";", 1)[0].trim().toLowerCase()).toBe("application/json")
  expect(
    overview.cacheControl
      ?.toLowerCase()
      .split(",")
      .map((value) => value.trim()),
  ).toContain("no-store")
  const workspace = expectAuthenticatedOverview(JSON.parse(overview.body))

  await expect
    .poll(() => [...state.pendingRequests], { message: "authenticated deployed app network did not settle" })
    .toEqual([])
  expectNoDeployedSmokeFailures(state)

  await page.goto(new URL(`/workspace/${encodeURIComponent(workspace.id)}/usage`, `${publicOrigin}/`).toString(), {
    waitUntil: "domcontentloaded",
  })
  expect(new URL(page.url()).origin).toBe(publicOrigin)
  expect(new URL(page.url()).pathname).toBe(`/workspace/${encodeURIComponent(workspace.id)}/usage`)
  await expect(page.getByRole("heading", { name: "Хэрэглээний түүх" })).toBeVisible()
  await expect(page.locator('nav[data-component="nav-desktop"] a[data-nav-button].active')).toHaveText("Хэрэглээ")
  await expect(page.locator('[data-slot="usage-table"]')).toBeVisible()
  await expect(page.locator('[data-slot="usage-table-element"], [data-component="empty-state"]')).toBeVisible()
  await expect(page.locator('[role="alert"]')).toHaveCount(0)

  await page.goto(new URL(`/workspace/${encodeURIComponent(workspace.id)}/billing`, `${publicOrigin}/`).toString(), {
    waitUntil: "domcontentloaded",
  })
  expect(new URL(page.url()).origin).toBe(publicOrigin)
  expect(new URL(page.url()).pathname).toBe(`/workspace/${encodeURIComponent(workspace.id)}/billing`)
  await expect(page.getByRole("heading", { name: "Багц ба төлбөр" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Төлбөрийн түүх" })).toBeVisible()
  await expect(page.locator('nav[data-component="nav-desktop"] a[data-nav-button].active')).toHaveText("Төлбөр тооцоо")
  await expect(page.locator('[data-slot="active-plan"], [data-slot="plans"], [data-slot="notice"]')).toBeVisible()
  await expect(page.locator('[data-slot="payments-table"], [data-slot="empty"]')).toBeVisible()
  await expect(page.locator('[role="alert"]')).toHaveCount(0)

  const planPicker = page.locator('[data-slot="plans"]')
  if (await planPicker.isVisible()) {
    await expect(planPicker.getByRole("button", { name: /Basic/ })).toBeVisible()
    await expect(planPicker.getByRole("button", { name: /Pro/ })).toBeVisible()
    await expect(planPicker.getByRole("button", { name: /Max/ })).toBeVisible()
    await expect(page.getByRole("button", { name: "QPay", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Bonum", exact: true })).toBeVisible()
  }

  const consoleSnapshot = await page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    text: document.body.innerText,
    readyState: document.readyState,
  }))
  expect(consoleSnapshot.title).toContain("MongolGPT")
  expect(consoleSnapshot.lang).toBe("mn")
  expect(consoleSnapshot.readyState).not.toBe("loading")
  expect(isVisibleMongolianText(consoleSnapshot.text)).toBe(true)

  await expect
    .poll(() => [...state.pendingRequests], { message: "authenticated account console network did not settle" })
    .toEqual([])
  expectNoDeployedSmokeFailures(state)
})

function expectAuthenticatedApiResponse(
  state: ReturnType<typeof observeDeployedPage>,
  origin: string,
  pathname: string,
  method: string,
  status: number,
) {
  const response = state.observedApiResponses.findLast(
    (entry) => entry.origin === origin && entry.pathname === pathname && entry.method === method,
  )
  expect(response, `${method} ${origin}${pathname} response was not observed`).toBeDefined()
  expect(response?.status).toBe(status)
  expect(response?.contentType).toBe("application/json")
  expect(response?.cacheControl.split(",").map((value) => value.trim())).toContain("no-store")
}

function hasAuthenticatedApiResponse(
  state: ReturnType<typeof observeDeployedPage>,
  origin: string,
  pathname: string,
  method: string,
  status: number,
) {
  return state.observedApiResponses.some(
    (entry) =>
      entry.origin === origin &&
      entry.pathname === pathname &&
      entry.method === method &&
      entry.status === status &&
      entry.contentType === "application/json" &&
      entry.cacheControl
        .split(",")
        .map((value) => value.trim())
        .includes("no-store"),
  )
}

function expectAuthenticatedOverview(value: unknown): AccountOverview["workspaces"][number] {
  const parsed = AccountOverviewSchema.safeParse(value)
  if (!parsed.success) throw new Error("Authenticated account overview did not match the account contract")
  if (!parsed.data.currentWorkspaceID) {
    throw new Error("Authenticated account overview did not include a current workspace")
  }
  const workspace = parsed.data.workspaces.find((item) => item.id === parsed.data.currentWorkspaceID)
  if (!workspace) throw new Error("Authenticated account overview did not include the selected workspace")
  if (workspace.role !== "admin") {
    throw new Error("Authenticated deployment smoke account must administer its current workspace")
  }
  return workspace
}
