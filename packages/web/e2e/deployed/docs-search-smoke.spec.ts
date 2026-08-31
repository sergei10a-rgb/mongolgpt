import { expect, test } from "@playwright/test"
import { requiredDocsSearchResults, requiredDocsTopics } from "../../docs-contract"

const docsURL = process.env.PLAYWRIGHT_DEPLOYED_DOCS_URL!
const deployedSearchResults = requiredDocsSearchResults.filter(([, path]) =>
  ["/docs/providers/", "/docs/plugins/", "/docs/billing/", "/docs/admin/"].includes(path),
)

test("Монгол баримт бичиг болон хайлт desktop, mobile дээр ажиллана", async ({ page, request }) => {
  const pageErrors: string[] = []
  const failedRequests: string[] = []
  const docsOrigin = new URL(docsURL).origin

  for (const slug of requiredDocsTopics) {
    const response = await request.get(new URL(`${slug}/`, docsURL).toString())
    expect(response.status(), `${slug} status`).toBe(200)
    expect(response.headers()["content-type"], `${slug} content-type`).toContain("text/html")
    const artifact = await response.text()
    expect(artifact, `${slug} lang`).toMatch(/<html\s[^>]*lang="mn"(?:\s|>)/i)
    expect(artifact, `${slug} title`).toMatch(/<title>[^<]*MongolGPT[^<]*<\/title>/i)
    expect(artifact, `${slug} legacy branding`).not.toMatch(/\bopencode(?:\.ai)?\b|\bopen\s+code\b/i)
  }

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
  await expect(dialog.getByRole("search", { name: "Энэ сайтаас хайх", exact: true })).toBeVisible()
  const input = dialog.getByPlaceholder("Хайх")
  await expect(input).toBeVisible()
  for (const [query, expectedPath] of deployedSearchResults) {
    await input.fill(query)
    await expect(dialog.getByRole("button", { name: "Хайлтыг арилгах", exact: true })).toBeVisible()
    await expect(dialog.locator(`a[href="${expectedPath}"]`).first(), `${query} -> ${expectedPath}`).toBeVisible()
  }

  await expect(page.getByRole("figure", { name: "Терминалын цонх", exact: true }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: "Түр санах ойд хуулах", exact: true }).first()).toBeVisible()

  expect(pageErrors, "browser errors").toEqual([])
  expect(failedRequests, "failed same-origin docs requests").toEqual([])
})
