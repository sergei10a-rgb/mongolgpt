import { expect, test } from "@playwright/test"

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const

for (const viewport of viewports) {
  test(`renders the suspended account notice in Mongolian on ${viewport.name}`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = []
    const failedRequests: string[] = []

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown error"}`)
    })

    await page.setViewportSize(viewport)
    const response = await page.goto("/auth/suspended", { waitUntil: "networkidle" })

    expect(response?.status()).toBe(200)
    await expect(page).toHaveTitle("MongolGPT аккаунт түр түдгэлзсэн")
    await expect(page.getByRole("heading", { name: "Аккаунт түр түдгэлзсэн байна" })).toBeVisible()
    await expect(
      page.getByText("Таны вэб, ширээний програм, CLI болон API түлхүүр ашиглах эрх түр хаагдсан."),
    ).toBeVisible()
    await expect(page.getByRole("link", { name: "Сессээс гарах" })).toBeVisible()

    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
    }))
    expect(layout.body).toBeLessThanOrEqual(layout.viewport)
    expect(layout.document).toBeLessThanOrEqual(layout.viewport)
    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])

    await page.screenshot({ path: testInfo.outputPath(`suspended-${viewport.name}.png`), fullPage: true })
  })
}
