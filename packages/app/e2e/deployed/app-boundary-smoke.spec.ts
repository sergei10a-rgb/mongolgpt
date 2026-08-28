import { expect, test } from "@playwright/test"
import { isStaticAppBackendPath, staticAppBackendBoundaryPaths } from "../../src/utils/static-app-router"
import { isVisibleMongolianText } from "./network"

const backendResourceTypes = new Set(["fetch", "xhr"])
const rejectionBody = {
  code: "STATIC_APP_API_ROUTE",
  message: "MongolGPT веб аппын хаяг дээр API ажиллахгүй. Тохируулсан backend хаягийг ашиглана уу.",
}

test("keeps the deployed app on its static boundary without requiring a live runtime", async ({ page, request }) => {
  const appOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_BASE_URL!).origin
  const publicOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_PUBLIC_URL!).origin
  const runtimeOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_RUNTIME_URL!).origin
  const expectedReleaseSha = process.env.PLAYWRIGHT_DEPLOYED_RELEASE_SHA
  const expectedChannel = process.env.PLAYWRIGHT_DEPLOYED_CHANNEL ?? "dev"
  const pageErrors: string[] = []
  const sameOriginBackendRequests: string[] = []
  const sameOriginBackendHtml: string[] = []

  expect(publicOrigin).not.toBe(appOrigin)
  expect(runtimeOrigin).not.toBe(appOrigin)
  expect(runtimeOrigin).not.toBe(publicOrigin)

  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url())
    if (url.origin !== appOrigin) return
    if (!backendResourceTypes.has(browserRequest.resourceType())) return
    if (!isStaticAppBackendPath(url.pathname)) return
    sameOriginBackendRequests.push(`${browserRequest.method()} ${url.pathname}`)
  })
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.origin !== appOrigin || !isStaticAppBackendPath(url.pathname)) return
    const contentType = response.headers()["content-type"]?.split(";", 1)[0].trim().toLowerCase()
    if (contentType === "text/html") sameOriginBackendHtml.push(`${response.status()} ${url.pathname}`)
  })

  await page.goto("/new-session", { waitUntil: "domcontentloaded" })
  expect(new URL(page.url()).origin).toBe(appOrigin)
  expect(new URL(page.url()).pathname).toBe("/new-session")
  await expect(page.getByRole("heading", { name: "MongolGPT-д нэвтэрнэ үү" })).toBeVisible()

  const snapshot = await page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    text: document.body.innerText,
    channel: document.querySelector('meta[name="mongolgpt-channel"]')?.getAttribute("content"),
    runtimeMode: document.querySelector('meta[name="mongolgpt-runtime-mode"]')?.getAttribute("content"),
    serverUrl: document.querySelector('meta[name="mongolgpt-server-url"]')?.getAttribute("content"),
    releaseSha: document.querySelector('meta[name="mongolgpt-release-sha"]')?.getAttribute("content"),
  }))

  expect(snapshot.title).toContain("MongolGPT")
  expect(snapshot.lang).toBe("mn")
  expect(isVisibleMongolianText(snapshot.text)).toBe(true)
  expect(snapshot.channel).toBe(expectedChannel)
  expect(snapshot.runtimeMode).toBe("hosted")
  expect(snapshot.serverUrl).toBe(runtimeOrigin)
  expect(snapshot.releaseSha).toMatch(/^[0-9a-f]{40}$/)
  if (expectedReleaseSha) expect(snapshot.releaseSha).toBe(expectedReleaseSha)

  for (const pathname of staticAppBackendBoundaryPaths) {
    const response = await request.get(new URL(pathname, `${appOrigin}/`).toString(), {
      headers: { Accept: "application/json" },
    })
    const headers = response.headers()
    expect(response.status(), pathname).toBe(404)
    expect(headers["content-type"]?.split(";", 1)[0].trim().toLowerCase(), pathname).toBe("application/json")
    expect(
      headers["cache-control"]
        ?.toLowerCase()
        .split(",")
        .map((value) => value.trim()),
      pathname,
    ).toContain("no-store")
    expect(headers["x-content-type-options"], pathname).toBe("nosniff")
    expect(await response.json(), pathname).toEqual(rejectionBody)
  }

  expect(pageErrors, "page errors").toEqual([])
  expect(sameOriginBackendRequests, "same-origin backend requests").toEqual([])
  expect(sameOriginBackendHtml, "html returned from app backend paths").toEqual([])
})
