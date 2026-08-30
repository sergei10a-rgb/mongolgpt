import { expect, test } from "@playwright/test"
import { isVisibleMongolianText } from "./network"

test("renders the public MongolGPT console without hydration or responsive failures", async ({ page }) => {
  const publicOrigin = new URL(process.env.PLAYWRIGHT_DEPLOYED_PUBLIC_URL!).origin
  const pageErrors: string[] = []
  const consoleErrors: string[] = []

  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  await page.goto(publicOrigin, { waitUntil: "domcontentloaded" })
  expect(new URL(page.url()).origin).toBe(publicOrigin)
  await expect(page.getByRole("heading", { name: "MongolGPT", exact: true })).toBeVisible()

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
  await page.goto(new URL("/auth", `${publicOrigin}/`).toString(), { waitUntil: "domcontentloaded" })
  expect(new URL(page.url()).origin).toBe(publicOrigin)
  const auth = await page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    text: document.body.innerText,
  }))

  expect(auth.title).toContain("MongolGPT")
  expect(auth.lang).toMatch(/^mn(?:-MN)?$/)
  expect(isVisibleMongolianText(auth.text)).toBe(true)
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
