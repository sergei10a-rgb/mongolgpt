import { expect, test } from "@playwright/test"

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
] as const

test("explains how to connect the local MongolGPT engine", async ({ page }) => {
  await page.addInitScript(() => {
    window.open = ((url?: string | URL) => {
      document.documentElement.dataset.openedUrl = String(url)
      return null
    }) as typeof window.open
  })
  await page.route(/^https?:\/\/(localhost|127\.0\.0\.1):4096\/.*/, (route) => route.abort())

  for (const viewport of viewports) {
    await test.step(viewport.name, async () => {
      await page.setViewportSize(viewport)
      await page.goto("/")

      await expect(page.getByRole("heading", { name: "MongolGPT хөдөлгүүрээ асаана уу" })).toBeVisible()
      await expect(page.getByText("mongolgpt serve --port 4096", { exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Дахин шалгах" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Суулгах заавар" })).toBeVisible()
      if (viewport.name === "desktop") {
        await page.getByRole("button", { name: "Суулгах заавар" }).click()
        const openedUrl = await page.locator("html").getAttribute("data-opened-url")
        expect(openedUrl).toMatch(/\/docs\/web\/$/)
        expect(openedUrl).not.toContain("/docs/docs/")
      }

      const runtime = await page.evaluate(() => ({
        language: document.documentElement.lang,
        mode: document.querySelector('meta[name="mongolgpt-runtime-mode"]')?.getAttribute("content"),
        server: document.querySelector('meta[name="mongolgpt-server-url"]')?.getAttribute("content"),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }))

      expect(runtime).toMatchObject({
        language: "mn",
        mode: "local-bridge",
      })
      expect(runtime.server).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):4096$/)
      expect(runtime.overflow).toBeLessThanOrEqual(1)
    })
  }
})
