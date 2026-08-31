import { expect, test } from "@playwright/test"
import { isVisibleMongolianText } from "../deployed/network"

test("hydrates the production console build on desktop and mobile", async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []

  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "MongolGPT", exact: true })).toBeVisible()
  await expect(page.locator('[data-component="preview-notice"]')).toContainText("Бодит төлбөр идэвхгүй")
  await expect
    .poll(() =>
      page.locator("img").evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)),
    )
    .toBe(true)

  const desktop = await page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    text: document.body.innerText,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    brokenImages: [...document.images]
      .filter((image) => !image.complete || image.naturalWidth === 0)
      .map((image) => image.alt || image.currentSrc),
  }))

  expect(desktop.title).toContain("MongolGPT")
  expect(desktop.lang).toBe("mn-MN")
  expect(isVisibleMongolianText(desktop.text)).toBe(true)
  expect(desktop.scrollWidth).toBeLessThanOrEqual(desktop.clientWidth)
  expect(desktop.brokenImages).toEqual([])

  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.getByRole("button", { name: "Цэс нээх" })).toBeVisible()
  const mobile = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))

  expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.clientWidth)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/pricing", { waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-component="pricing-status"]')).toHaveAttribute("data-status", "disabled")
  await expect(page.locator('[data-plan="free"] a[data-slot="plan-action"]')).toHaveAttribute("href", "/auth")
  for (const plan of ["basic", "pro", "max"] as const) {
    const action = page.locator(`[data-plan="${plan}"] [data-slot="plan-action"]`)
    await expect(action).toHaveAttribute("aria-disabled", "true")
    await expect(action).toHaveText("Одоогоор идэвхгүй")
    await expect(page.locator(`[data-plan="${plan}"] a[data-slot="plan-action"]`)).toHaveCount(0)
  }

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
