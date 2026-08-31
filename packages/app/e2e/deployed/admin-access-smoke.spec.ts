import { expect, test } from "@playwright/test"

test("renders the protected MongolGPT admin boundary", async ({ page }, testInfo) => {
  const adminURL = new URL(process.env.PLAYWRIGHT_DEPLOYED_ADMIN_URL!)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const failedAdminRequests: string[] = []

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).hostname === adminURL.hostname) {
      failedAdminRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`)
    }
  })

  await page.goto(adminURL.toString(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toBeVisible()
  await expect
    .poll(async () => (await page.locator("body").innerText()).trim(), {
      message: "Cloudflare Access boundary did not render visible content",
    })
    .not.toBe("")

  const current = new URL(page.url())
  expect(current.hostname.endsWith(".cloudflareaccess.com")).toBe(true)
  expect(current.pathname).toContain("/cdn-cgi/access/")
  expect(decodeURIComponent(current.toString())).toContain(adminURL.hostname)

  const snapshot = await page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText.trim(),
    readyState: document.readyState,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(snapshot.readyState).not.toBe("loading")
  expect(`${snapshot.title}\n${snapshot.text}`).toContain("MongolGPT админ")
  expect(snapshot.text.length).toBeGreaterThan(20)
  expect(snapshot.scrollWidth).toBeLessThanOrEqual(snapshot.clientWidth)

  await page.screenshot({ path: testInfo.outputPath("admin-access.png"), fullPage: true })
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
  expect(failedAdminRequests).toEqual([])
})
