import { expect, test } from "@playwright/test"
import { expectNoDeployedSmokeFailures, isVisibleMongolianText, observeDeployedPage } from "./network"

test.describe.configure({ mode: "serial" })

test("shows an anonymous MongolGPT UI and avoids same-origin backend routing", async ({ page }) => {
  const appOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_BASE_URL!).origin
  const publicOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_PUBLIC_URL!).origin
  const state = observeDeployedPage(page, appOrigin)

  expect(publicOrigin).not.toBe(appOrigin)

  await page.goto("/", { waitUntil: "domcontentloaded" })
  expect(new URL(page.url()).origin).toBe(appOrigin)
  expect(new URL(page.url()).pathname).toBe("/")

  await expect
    .poll(async () => {
      const body = await page.locator("body").innerText()
      return isVisibleMongolianText(body) ? body : ""
    })
    .not.toBe("")

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
  expect(snapshot.text.length).toBeGreaterThan(80)

  await expect(page.getByRole("heading", { name: "MongolGPT-д нэвтэрнэ үү" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Нэвтрэх" })).toBeVisible()
  const accountOverview = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    }
  }, new URL("/v1/account/overview", `${publicOrigin}/`).toString())
  expect(accountOverview.status).toBe(401)
  expect(accountOverview.contentType?.split(";", 1)[0].trim().toLowerCase()).toBe("application/json")
  expect(JSON.parse(accountOverview.body)).toEqual({
    error: "unauthorized",
    message: "MongolGPT бүртгэлээр нэвтэрнэ үү.",
  })
  await expect.poll(() => state.pendingRequests.size, { message: "deployed app network did not settle" }).toBe(0)

  expectNoDeployedSmokeFailures(state)

  await page.goto("/new-session", { waitUntil: "domcontentloaded" })
  expect(new URL(page.url()).origin).toBe(appOrigin)
  expect(new URL(page.url()).pathname).toBe("/new-session")
  await expect(page.getByRole("heading", { name: "MongolGPT-д нэвтэрнэ үү" })).toBeVisible()
  await expect.poll(() => state.pendingRequests.size, { message: "direct navigation network did not settle" }).toBe(0)

  expectNoDeployedSmokeFailures(state)
})
