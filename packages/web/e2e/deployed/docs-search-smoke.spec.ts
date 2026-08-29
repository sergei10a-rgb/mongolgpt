import { expect, test } from "@playwright/test"

const docsURL = process.env.PLAYWRIGHT_DEPLOYED_DOCS_URL!

test("Монгол баримт бичиг болон хайлт desktop, mobile дээр ажиллана", async ({ page }) => {
  const pageErrors: string[] = []
  const failedRequests: string[] = []
  const docsOrigin = new URL(docsURL).origin

  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text())
  })
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin !== docsOrigin) return
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`)
  })

  const response = await page.goto(docsURL, { waitUntil: "domcontentloaded" })
  expect(response?.status()).toBe(200)
  await expect(page.getByRole("heading", { name: "MongolGPT баримт бичиг", exact: true })).toBeVisible()
  await page.waitForLoadState("networkidle")

  const documentState = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(documentState.lang).toBe("mn")
  expect(documentState.title).toContain("MongolGPT")
  expect(documentState.scrollWidth).toBeLessThanOrEqual(documentState.clientWidth + 1)

  const menuButton = page.getByRole("button", { name: "Цэс", exact: true })
  if (await menuButton.isVisible()) {
    await menuButton.click()
    await expect(menuButton).toHaveAttribute("aria-expanded", "true")
  }

  const searchButton = page.getByRole("button", { name: "Хайх", exact: true }).first()
  await expect(searchButton).toBeEnabled()
  await searchButton.click()

  const dialog = page.getByRole("dialog", { name: "Хайх", exact: true })
  await expect(dialog).toBeVisible()
  const input = dialog.getByPlaceholder("Хайх")
  await expect(input).toBeVisible()
  await input.fill("OpenRouter")
  await expect(dialog.locator(".pagefind-ui__result").first()).toContainText(/OpenRouter/i)

  expect(pageErrors, "browser errors").toEqual([])
  expect(failedRequests, "failed same-origin docs requests").toEqual([])
})
