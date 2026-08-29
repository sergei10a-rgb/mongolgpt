import { expect, test } from "@playwright/test"
import { expectNoDeployedSmokeFailures, isVisibleMongolianText, observeDeployedPage } from "./network"

test.describe.configure({ mode: "serial" })

test("shows an anonymous MongolGPT UI and avoids same-origin backend routing", async ({ page }) => {
  const appOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_BASE_URL!).origin
  const publicOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_PUBLIC_URL!).origin
  const runtimeOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_RUNTIME_URL!).origin
  const expectedReleaseSha = process.env.PLAYWRIGHT_DEPLOYED_RELEASE_SHA
  const state = observeDeployedPage(page, appOrigin, [publicOrigin, runtimeOrigin])

  expect(publicOrigin).not.toBe(appOrigin)
  expect(runtimeOrigin).not.toBe(appOrigin)
  expect(runtimeOrigin).not.toBe(publicOrigin)
  if (expectedReleaseSha) expect(expectedReleaseSha).toMatch(/^[0-9a-f]{40}$/)

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
  const deployedReleaseSha = await page.locator('meta[name="mongolgpt-release-sha"]').getAttribute("content")
  expect(deployedReleaseSha).toMatch(/^[0-9a-f]{40}$/)
  if (expectedReleaseSha) expect(deployedReleaseSha).toBe(expectedReleaseSha)
  expect(isVisibleMongolianText(snapshot.text)).toBe(true)
  expect(snapshot.text.length).toBeGreaterThan(80)

  await expect(page.getByRole("heading", { name: "MongolGPT-д нэвтэрнэ үү" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Нэвтрэх" })).toBeVisible()
  const accountOverview = await page.evaluate(
    async (url) => {
      const response = await fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json" },
      })
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      }
    },
    new URL("/v1/account/overview", `${publicOrigin}/`).toString(),
  )
  expect(accountOverview.status).toBe(401)
  expect(accountOverview.contentType?.split(";", 1)[0].trim().toLowerCase()).toBe("application/json")
  expect(JSON.parse(accountOverview.body)).toEqual({
    error: "unauthorized",
    message: "MongolGPT бүртгэлээр нэвтэрнэ үү.",
  })

  const hostedBoundaries = await page.evaluate(
    async ({ publicOrigin, runtimeOrigin }) => {
      const request = async (url: string, init?: RequestInit) => {
        const response = await fetch(url, {
          credentials: "include",
          headers: { Accept: "application/json" },
          ...init,
        })
        return {
          url: response.url,
          status: response.status,
          contentType: response.headers.get("content-type"),
          cacheControl: response.headers.get("cache-control"),
          body: await response.text(),
        }
      }

      const [runtimeToken, session, project] = await Promise.all([
        request(new URL("/auth/runtime-token", `${publicOrigin}/`).toString(), { method: "POST" }),
        request(new URL("/auth/session", `${runtimeOrigin}/`).toString()),
        request(new URL("/project", `${runtimeOrigin}/`).toString()),
      ])
      return { runtimeToken, session, project }
    },
    { publicOrigin, runtimeOrigin },
  )

  expectDeployedJson(hostedBoundaries.runtimeToken, publicOrigin, 401, {
    error: "unauthorized",
    message: "MongolGPT бүртгэлээр нэвтэрнэ үү.",
  })
  expectDeployedJson(hostedBoundaries.session, runtimeOrigin, 401, { authenticated: false })
  expectDeployedJson(hostedBoundaries.project, runtimeOrigin, 401, { error: "Нэвтэрч орно уу." })
  await expect.poll(() => [...state.pendingRequests], { message: "deployed app network did not settle" }).toEqual([])

  expectNoDeployedSmokeFailures(state)

  await page.goto("/new-session", { waitUntil: "domcontentloaded" })
  expect(new URL(page.url()).origin).toBe(appOrigin)
  expect(new URL(page.url()).pathname).toBe("/new-session")
  await expect(page.getByRole("heading", { name: "MongolGPT-д нэвтэрнэ үү" })).toBeVisible()
  await expect.poll(() => [...state.pendingRequests], { message: "direct navigation network did not settle" }).toEqual([])

  expectNoDeployedSmokeFailures(state)
})

function expectDeployedJson(
  response: { url: string; status: number; contentType: string | null; cacheControl: string | null; body: string },
  origin: string,
  status: number,
  body: unknown,
) {
  expect(new URL(response.url).origin).toBe(origin)
  expect(response.status).toBe(status)
  expect(response.contentType?.split(";", 1)[0].trim().toLowerCase()).toBe("application/json")
  expect(
    response.cacheControl
      ?.toLowerCase()
      .split(",")
      .map((value) => value.trim()),
  ).toContain("no-store")
  expect(JSON.parse(response.body)).toEqual(body)
}
